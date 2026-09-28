import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	calculateCost,
	createAssistantMessageEventStream,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { getAgentDir } from "../../../../config.ts";
import type { BridgeCallResult, BridgeTool } from "./bridge-server.ts";
import { resolveAgyExecutable } from "./executable.ts";
import { agySettingsPath, hasBridgePermissionRule } from "./permission-rule.ts";
import { renderBootstrap, renderUserTurn } from "./prompt.ts";
import {
	type AgySession,
	type AgySessionBinding,
	closeSession,
	decideContinuity,
	getBinding,
	getSession,
	messagePrefixDigest,
	prepareAgySession,
	rememberSessionBinding,
	startAgySession,
} from "./session.ts";
import type { AntigravitySubscriptionSettings } from "./settings.ts";
import { loadAntigravitySubscriptionSettingsFromDisk } from "./settings.ts";
import { type AgyUsage, sumUsage } from "./stream-parser.ts";

const PERMISSION_GUIDANCE =
	"Antigravity needs permission to run senpi's tools inside agy. Run /login antigravity-subscription to grant it.";
/**
 * agy keeps a few internal bookkeeping tools even with the agent's `tools: []`. They never touch the host,
 * so they pass; every other builtin (commands, files, browser, subagents) fails the turn closed.
 */
const AGY_TOOLS_WITHOUT_HOST_EFFECT: ReadonlySet<string> = new Set(["call_mcp_tool", "manage_task", "finish"]);
const AUTH_GUIDANCE = "Antigravity CLI is not signed in. Run `agy` once in a terminal to sign in, then retry.";

export type AntigravityBinding = AgySessionBinding;

export type AntigravityStreamDeps = {
	readonly resolveExecutable: (settings: AntigravitySubscriptionSettings) => string;
	readonly loadSettings: () => AntigravitySubscriptionSettings;
	readonly agentDir: string;
	readonly permissionRulePresent: () => boolean;
	readonly homeDir: string;
	readonly onBinding?: (key: string, binding: AntigravityBinding) => void;
};

const defaultDeps: AntigravityStreamDeps = {
	resolveExecutable: (settings) => resolveAgyExecutable(settings),
	loadSettings: () => loadAntigravitySubscriptionSettingsFromDisk(process.cwd()),
	agentDir: getAgentDir(),
	permissionRulePresent: () => hasBridgePermissionRule(agySettingsPath(homedir())),
	homeDir: homedir(),
};

export function createAntigravityStream(
	deps: AntigravityStreamDeps,
): (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream {
	return (model, context, options) => {
		const stream = createAssistantMessageEventStream();
		void runStream(stream, model, context, options, deps);
		return stream;
	};
}

export const streamAntigravitySubscription = createAntigravityStream(defaultDeps);

type StreamState = {
	readonly stream: AssistantMessageEventStream;
	readonly output: AssistantMessage;
	readonly model: Model<Api>;
	usage: AgyUsage | undefined;
	openTextIndex: number | undefined;
	streamedText: boolean;
};

async function runStream(
	stream: AssistantMessageEventStream,
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	deps: AntigravityStreamDeps,
): Promise<void> {
	const output = emptyOutput(model);
	const state: StreamState = {
		stream,
		output,
		model,
		usage: undefined,
		openTextIndex: undefined,
		streamedText: false,
	};
	let session: AgySession | undefined;
	let ephemeral = false;
	let completed = false;
	try {
		if (options?.signal?.aborted) throw abortError(options.signal);
		const settings = deps.loadSettings();
		const executable = deps.resolveExecutable(settings);
		const requestedSessionId = options?.sessionId;
		ephemeral = options?.streamKind !== "main" || requestedSessionId === undefined || options.toolChoice === "none";
		if (!ephemeral && !deps.permissionRulePresent()) throw new Error(PERMISSION_GUIDANCE);

		const key = ephemeral ? `aux-${randomUUID()}` : requestedSessionId;
		if (key === undefined) throw new Error("Antigravity main streams require a session id.");
		const tools = ephemeral ? [] : bridgeTools(context);
		const prepared = await prepareAgySession({
			key,
			agentDir: deps.agentDir,
			systemPrompt: context.systemPrompt ?? "",
			projectCwd: process.cwd(),
		});
		const existing = getSession(key);
		const binding = getBinding(key);
		const syncedCount = existing?.syncedCount ?? binding?.syncedCount ?? 0;
		const newMessages = context.messages.slice(syncedCount);
		const beginsWithPendingToolResult =
			existing !== undefined &&
			newMessages[0]?.role === "toolResult" &&
			existing.queue.isPending(newMessages[0].toolCallId);

		if (
			existing !== undefined &&
			existing.queue.size > 0 &&
			!beginsWithPendingToolResult &&
			newMessages.some((message) => message.role === "user")
		) {
			closeSession(key, "interrupted by the user", { keepConversation: true });
		}

		const live = getSession(key);
		const currentBinding = getBinding(key);
		const effectiveSyncedCount = live?.syncedCount ?? currentBinding?.syncedCount ?? 0;
		const decision = ephemeral
			? "bootstrap"
			: decideContinuity({
					live: live !== undefined && !live.exited,
					modelMatches: live?.modelId === model.id,
					fingerprintMatches: live?.fingerprint === prepared.workspace.fingerprint,
					conversationId: live?.conversationId ?? currentBinding?.conversationId,
					syncedCount: effectiveSyncedCount,
					messageCount: context.messages.length,
					storedPrefixDigest: live?.prefixDigest ?? currentBinding?.prefixDigest ?? messagePrefixDigest([]),
					currentPrefixDigest: messagePrefixDigest(
						context.messages.slice(0, Math.max(0, effectiveSyncedCount - 1)),
					),
					resumeMode: settings.resumeMode ?? "auto",
					hasPendingCalls: live !== undefined && live.queue.size > 0,
					beginsWithPendingToolResult,
				});

		if (decision === "delta" || decision === "resolve-tools") {
			session = live;
			if (session === undefined) throw new Error("Antigravity continuity selected a missing resident session.");
			session.tools = tools;
			session.lastUsedAt = Date.now();
		} else {
			if (live !== undefined) closeSession(key, "continuity_restart", { keepConversation: true });
			const conversationId = decision === "reattach" ? currentBinding?.conversationId : undefined;
			session = startAgySession({
				prepared,
				executable,
				modelId: model.id,
				...(conversationId === undefined ? {} : { conversationId }),
				tools,
			});
			if (decision === "bootstrap") {
				session.conversationId = undefined;
				session.syncedCount = 0;
				session.prefixDigest = messagePrefixDigest([]);
			}
		}

		session.turnActive = true;
		stream.push({ type: "start", partial: output });
		if (decision === "resolve-tools") {
			resolvePendingTools(session, context.messages.slice(session.syncedCount));
		} else {
			const content =
				decision === "bootstrap"
					? renderBootstrapTurn(context.messages)
					: renderUserTurn(context.messages.slice(session.syncedCount));
			await writeTurn(session, content);
		}
		await pumpTurn(state, session, options?.signal);
		if (output.stopReason === "stop" || output.stopReason === "toolUse") {
			session.syncedCount = context.messages.length + 1;
			session.prefixDigest = messagePrefixDigest(context.messages);
			session.lastUsedAt = Date.now();
			const bindingResult = rememberSessionBinding(session);
			if (bindingResult !== undefined) deps.onBinding?.(session.key, bindingResult);
		}
		completed = true;
	} catch (error) {
		closeText(state);
		const aborted = options?.signal?.aborted === true || isAbortError(error);
		output.stopReason = aborted ? "aborted" : "error";
		output.errorMessage = aborted ? "aborted" : classifyError(error);
		if (session !== undefined && aborted) {
			closeSession(session.key, "aborted", { keepConversation: true });
		}
		stream.push({ type: "error", reason: output.stopReason, error: output });
	} finally {
		if (session !== undefined) session.turnActive = false;
		if (ephemeral && session !== undefined) {
			closeSession(session.key, completed ? "one_shot_complete" : "one_shot_failed", {
				keepConversation: false,
			});
		}
		stream.end();
	}
}

function bridgeTools(context: Context): BridgeTool[] {
	return (context.tools ?? []).map((tool) => ({
		name: tool.name,
		description: tool.description,
		inputSchema: { ...tool.parameters },
	}));
}

function renderBootstrapTurn(messages: readonly Message[]): string {
	let newTurnIndex = -1;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index]?.role === "user") {
			newTurnIndex = index;
			break;
		}
	}
	if (newTurnIndex < 0) return renderBootstrap([], messages);
	return renderBootstrap(messages.slice(0, newTurnIndex), messages.slice(newTurnIndex));
}

function resolvePendingTools(session: AgySession, newMessages: readonly Message[]): void {
	const results: ToolResultMessage[] = [];
	let index = 0;
	while (index < newMessages.length) {
		const message = newMessages[index];
		if (message?.role !== "toolResult" || !session.queue.isPending(message.toolCallId)) break;
		results.push(message);
		index += 1;
	}
	if (results.length === 0) throw new Error("Antigravity has no matching held tool calls to resolve.");
	const steering = newMessages.slice(index);
	for (let resultIndex = 0; resultIndex < results.length; resultIndex += 1) {
		const message = results[resultIndex];
		if (message === undefined) continue;
		const result = bridgeResult(message);
		if (resultIndex === results.length - 1 && steering.length > 0) {
			result.content.push({
				type: "text",
				text: `[message from the user while the tool ran]\n${renderUserTurn(steering)}`,
			});
		}
		if (!session.queue.resolve(message.toolCallId, result)) {
			throw new Error(`Antigravity tool call ${message.toolCallId} is no longer pending.`);
		}
	}
}

function bridgeResult(message: ToolResultMessage): BridgeCallResult {
	return {
		content: message.content.map((block) => {
			switch (block.type) {
				case "text":
					return { type: "text", text: block.text };
				case "image":
					return {
						type: "image",
						data: block.data,
						mimeType: block.mimeType,
					};
				default:
					return assertNever(block);
			}
		}),
		isError: message.isError,
	};
}

function writeTurn(session: AgySession, content: string): Promise<void> {
	const line = `${JSON.stringify({ event: "user", message: { content } })}\n`;
	return new Promise((resolve, reject) => {
		session.process.stdin.write(line, (error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

async function pumpTurn(state: StreamState, session: AgySession, signal: AbortSignal | undefined): Promise<void> {
	while (true) {
		if (signal?.aborted) throw abortError(signal);
		if (session.queue.hasUnclaimed()) {
			emitToolCalls(state, session);
			return;
		}
		const event = session.events.shift();
		if (event === undefined) {
			const readinessController = new AbortController();
			const readinessSignal = combinedSignal(signal, readinessController.signal);
			try {
				await Promise.race([
					session.queue.whenUnclaimed(readinessSignal),
					session.events.whenAvailable(readinessSignal),
				]);
			} finally {
				readinessController.abort();
			}
			continue;
		}
		switch (event.type) {
			case "init":
				session.conversationId = event.conversationId;
				break;
			case "step":
				if (event.usage !== undefined) state.usage = sumUsage(state.usage, event.usage);
				if (event.stepType === "agent_response" && event.textDelta) pushText(state, event.textDelta);
				if (
					event.stepType === "tool" &&
					event.toolName !== undefined &&
					!AGY_TOOLS_WITHOUT_HOST_EFFECT.has(event.toolName)
				) {
					closeSession(session.key, "builtin_tool_refused", { keepConversation: false });
					throw new Error(
						`agy ran its builtin tool ${event.toolName}; the antigravity-subscription lane refuses builtin tools.`,
					);
				}
				break;
			case "result":
				session.conversationId = event.conversationId;
				closeText(state);
				if (event.status !== "SUCCESS") throw new Error(event.error ?? `agy result status ${event.status}`);
				if (!state.streamedText && event.response.length > 0) pushCompleteText(state, event.response);
				closeText(state);
				applyUsage(state);
				state.output.stopReason = "stop";
				state.stream.push({ type: "done", reason: "stop", message: state.output });
				return;
			case "malformed":
				throw new Error(`agy emitted malformed stream data (${event.reason}): ${event.sample}`);
			case "exit":
				throw new Error(`agy exited unexpectedly (code ${event.code ?? "null"}): ${session.stderrTail}`);
			case "unknown":
				break;
			default:
				assertNever(event);
		}
	}
}

function emitToolCalls(state: StreamState, session: AgySession): void {
	let call = session.queue.takeUnclaimed();
	while (call !== undefined) {
		emitToolCall(state, call);
		call = session.queue.takeUnclaimed();
	}
	finishWithTools(state);
}

function emitToolCall(
	state: StreamState,
	call: { readonly toolCallId: string; readonly name: string; readonly args: Record<string, unknown> },
): void {
	closeText(state);
	const block = {
		type: "toolCall" as const,
		id: call.toolCallId,
		name: call.name,
		arguments: call.args,
	};
	const contentIndex = state.output.content.length;
	state.output.content.push(block);
	state.stream.push({ type: "toolcall_start", contentIndex, partial: state.output });
	state.stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: state.output });
}

function finishWithTools(state: StreamState): void {
	closeText(state);
	applyUsage(state);
	state.output.stopReason = "toolUse";
	state.stream.push({ type: "done", reason: "toolUse", message: state.output });
}

function pushText(state: StreamState, delta: string): void {
	if (state.openTextIndex === undefined) {
		state.openTextIndex = state.output.content.length;
		state.output.content.push({ type: "text", text: "" });
		state.stream.push({
			type: "text_start",
			contentIndex: state.openTextIndex,
			partial: state.output,
		});
	}
	const block = state.output.content[state.openTextIndex];
	if (block?.type !== "text") throw new Error("Antigravity text stream lost its open block.");
	block.text += delta;
	state.streamedText = true;
	state.stream.push({
		type: "text_delta",
		contentIndex: state.openTextIndex,
		delta,
		partial: state.output,
	});
}

function pushCompleteText(state: StreamState, text: string): void {
	pushText(state, text);
}

function closeText(state: StreamState): void {
	if (state.openTextIndex === undefined) return;
	const contentIndex = state.openTextIndex;
	const block = state.output.content[contentIndex];
	state.openTextIndex = undefined;
	if (block?.type !== "text") return;
	state.stream.push({
		type: "text_end",
		contentIndex,
		content: block.text,
		partial: state.output,
	});
}

function applyUsage(state: StreamState): void {
	state.output.usage.input = state.usage?.input_tokens ?? 0;
	state.output.usage.output = (state.usage?.output_tokens ?? 0) + (state.usage?.thinking_tokens ?? 0);
	state.output.usage.cacheRead = state.usage?.cache_read_tokens ?? 0;
	state.output.usage.totalTokens =
		state.output.usage.input +
		state.output.usage.output +
		state.output.usage.cacheRead +
		state.output.usage.cacheWrite;
	state.output.usage.cost = calculateCost(state.model, state.output.usage);
}

function emptyOutput(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function classifyError(error: unknown): string {
	const detail = error instanceof Error ? error.message : String(error);
	if (detail === PERMISSION_GUIDANCE) return detail;
	if (/auth|sign.?in|login|credential/i.test(detail)) return AUTH_GUIDANCE;
	if (/RESOURCE_EXHAUSTED|quota|429|rate.?limit/i.test(detail)) {
		return `${detail} (429 rate limit)`;
	}
	return detail;
}

function combinedSignal(primary: AbortSignal | undefined, local: AbortSignal): AbortSignal {
	return primary === undefined ? local : AbortSignal.any([primary, local]);
}

function isAbortError(error: unknown): boolean {
	return error instanceof DOMException && error.name === "AbortError";
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}

function assertNever(value: never): never {
	throw new Error(`Unexpected Antigravity stream variant: ${JSON.stringify(value)}`);
}

export default streamAntigravitySubscription;
