import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, watch } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	Api,
	AssistantMessage,
	Context,
	Message,
	Model,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stopBridgeServer } from "../../src/core/extensions/builtin/antigravity-subscription/bridge-server.ts";
import {
	closeAllSessions,
	decideContinuity,
	getSession,
	seedBinding,
} from "../../src/core/extensions/builtin/antigravity-subscription/session.ts";
import { createAntigravityStream } from "../../src/core/extensions/builtin/antigravity-subscription/stream.ts";

const fixture = join(import.meta.dirname, "../fixtures/antigravity-subscription/fake-agy.mjs");
const model: Model<Api> = {
	id: "gemini-3.8-flash-low",
	name: "Fake Antigravity",
	api: "antigravity-subscription",
	provider: "antigravity-subscription",
	baseUrl: "antigravity-subscription",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 64_000,
};
const roots: string[] = [];

afterEach(async () => {
	closeAllSessions();
	await stopBridgeServer();
	vi.unstubAllEnvs();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Antigravity subscription stream", () => {
	it("streams text and reuses one resident agy process for the next delta", async () => {
		const world = await createWorld();
		const firstContext = context([user("ECHO:alpha")]);
		const first = await world.run(firstContext);
		expect(text(first)).toBe("alpha");
		expect(first.usage).toMatchObject({ input: 10, output: 5, totalTokens: 15 });

		const second = await world.run(context([...firstContext.messages, first, user("ECHO:beta")]));
		expect(text(second)).toBe("beta");
		expect((await logRows(world.sessionDir())).filter(hasArgv)).toHaveLength(1);
	});

	it("holds a bridge call across toolUse and resumes it with the tool result", async () => {
		const world = await createWorld();
		const firstContext = context(
			[user('CALL:read:{"path":"probe.txt"}')],
			[
				{
					name: "read",
					description: "Read a file",
					parameters: { type: "object", properties: { path: { type: "string" } } },
				},
			],
		);
		const first = await world.run(firstContext);
		const call = first.content.find((block) => block.type === "toolCall");
		expect(first.stopReason).toBe("toolUse");
		expect(call).toMatchObject({ type: "toolCall", name: "read", arguments: { path: "probe.txt" } });
		if (call?.type !== "toolCall") throw new Error("missing tool call");

		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			content: [{ type: "text", text: "held-ok" }],
			isError: false,
			timestamp: 3,
		};
		const second = await world.run(context([...firstContext.messages, first, result], firstContext.tools));
		expect(text(second)).toBe("TOOL_RESULT:held-ok");
		expect((await logRows(world.sessionDir())).filter(hasArgv)).toHaveLength(1);
	});

	it("preserves a tool call and event that become ready in the same tick", async () => {
		const world = await createWorld();
		const firstContext = context([user("HANG")]);
		const firstStream = world.stream(model, firstContext, {
			streamKind: "main",
			sessionId: world.sessionId,
		});
		const started = await firstStream[Symbol.asyncIterator]().next();
		expect(started.value?.type).toBe("start");
		const session = getSession(world.sessionId);
		if (session === undefined) throw new Error("missing resident session");
		await waitForLog(
			session.workspace.dir,
			'"stdin":"{\\"event\\":\\"user\\",\\"message\\":{\\"content\\":\\"HANG\\"}}"',
		);

		const queuedResult = session.queue.enqueue("race_probe", { value: 1 }, new AbortController().signal);
		session.events.push({
			type: "result",
			conversationId: "race-conversation",
			status: "SUCCESS",
			response: "buffered-result",
		});

		const first = await firstStream.result();
		const call = first.content.find((block) => block.type === "toolCall");
		expect(call).toMatchObject({
			type: "toolCall",
			name: "race_probe",
			arguments: { value: 1 },
		});
		if (call?.type !== "toolCall") throw new Error("missing raced tool call");
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			content: [{ type: "text", text: "race-tool-result" }],
			isError: false,
			timestamp: 3,
		};
		const second = await world.run(context([...firstContext.messages, first, result]));

		expect(text(second)).toBe("buffered-result");
		await expect(queuedResult).resolves.toEqual({
			content: [{ type: "text", text: "race-tool-result" }],
			isError: false,
		});
	});

	it("reattaches a persisted conversation after the resident process closes", async () => {
		const world = await createWorld();
		const firstContext = context([user("ECHO:remembered")]);
		const first = await world.run(firstContext);
		const session = getSession(world.sessionId);
		if (session?.conversationId === undefined) throw new Error("missing conversation binding");
		const binding = {
			conversationId: session.conversationId,
			syncedCount: session.syncedCount,
			prefixDigest: session.prefixDigest,
			modelId: session.modelId,
		};

		closeAllSessions();
		seedBinding(world.sessionId, binding);
		const recalled = await world.run(context([...firstContext.messages, first, user("RECALL")]));

		expect(text(recalled)).toBe("remembered");
		const argv = (await logRows(world.sessionDir())).filter(hasArgv).map((row) => row.argv);
		expect(argv).toHaveLength(2);
		expect(argv[1]).toEqual(expect.arrayContaining(["--conversation", binding.conversationId]));
	});

	it("starts a fresh bootstrap when the persisted prefix diverges", async () => {
		const world = await createWorld();
		seedBinding(world.sessionId, {
			conversationId: "stale-conversation",
			syncedCount: 2,
			prefixDigest: "not-the-current-prefix",
			modelId: model.id,
		});

		expect(text(await world.run(context([user("ECHO:fresh")])))).toBe("fresh");
		const argv = (await logRows(world.sessionDir())).find(hasArgv)?.argv ?? [];
		expect(argv).not.toContain("--conversation");
	});

	it("refuses a missing permission rule before spawning agy", async () => {
		const world = await createWorld(false);
		const result = await world.run(context([user("ECHO:no-spawn")]));

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe(
			"Antigravity needs permission to run senpi's tools inside agy. Run /login antigravity-subscription to grant it.",
		);
		expect(existsSync(join(world.agentDir, "antigravity-subscription"))).toBe(false);
	});

	it("fails closed when agy reports a builtin tool step", async () => {
		const world = await createWorld();
		const result = await world.run(context([user("BUILTIN")]));

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe(
			"agy ran its builtin tool run_command; the antigravity-subscription lane refuses builtin tools.",
		);
		expect(getSession(world.sessionId)).toBeUndefined();
	});

	it("lets agy's internal manage_task bookkeeping step through", async () => {
		const world = await createWorld();
		const result = await world.run(context([user("MANAGE_TASK")]));

		expect(result.stopReason).toBe("stop");
		expect(text(result)).toBe("task-noted");
	});

	it("classifies authentication and quota failures with actionable text", async () => {
		const authWorld = await createWorld();
		const auth = await authWorld.run(context([user("AUTHFAIL")]));
		expect(auth.errorMessage).toBe(
			"Antigravity CLI is not signed in. Run `agy` once in a terminal to sign in, then retry.",
		);

		closeAllSessions();
		const quotaWorld = await createWorld();
		const quota = await quotaWorld.run(context([user("QUOTA")]));
		expect(quota.errorMessage).toContain("RESOURCE_EXHAUSTED: quota exceeded (429)");
		expect(quota.errorMessage).toContain("(429 rate limit)");
	});

	it("aborts a hanging turn and terminates its resident process", async () => {
		const world = await createWorld();
		const controller = new AbortController();
		const stream = world.stream(model, context([user("HANG")]), {
			streamKind: "main",
			sessionId: world.sessionId,
			signal: controller.signal,
		});
		const firstEvent = await stream[Symbol.asyncIterator]().next();
		expect(firstEvent.value?.type).toBe("start");
		const session = getSession(world.sessionId);
		if (session === undefined) throw new Error("missing resident session");
		await waitForLog(
			session.workspace.dir,
			'"stdin":"{\\"event\\":\\"user\\",\\"message\\":{\\"content\\":\\"HANG\\"}}"',
		);
		const closed = once(session.process, "close");

		controller.abort();
		const result = await stream.result();

		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toBe("aborted");
		expect(getSession(world.sessionId)).toBeUndefined();
		await closed;
	});
});

describe("decideContinuity", () => {
	it("prioritizes held tool results, then delta, reattach, and bootstrap", () => {
		const base = {
			live: true,
			modelMatches: true,
			fingerprintMatches: true,
			conversationId: "conversation",
			syncedCount: 2,
			messageCount: 3,
			storedPrefixDigest: "same",
			currentPrefixDigest: "same",
			resumeMode: "auto" as const,
			hasPendingCalls: false,
			beginsWithPendingToolResult: false,
		};
		expect(decideContinuity({ ...base, hasPendingCalls: true, beginsWithPendingToolResult: true })).toBe(
			"resolve-tools",
		);
		expect(decideContinuity(base)).toBe("delta");
		expect(decideContinuity({ ...base, live: false })).toBe("reattach");
		expect(decideContinuity({ ...base, currentPrefixDigest: "different" })).toBe("bootstrap");
		expect(decideContinuity({ ...base, live: false, resumeMode: "off" })).toBe("bootstrap");
	});
});

async function createWorld(permission = true): Promise<{
	readonly agentDir: string;
	readonly sessionId: string;
	readonly stream: ReturnType<typeof createAntigravityStream>;
	readonly run: (value: Context) => Promise<AssistantMessage>;
	readonly sessionDir: () => string;
}> {
	const root = await mkdtemp(join(tmpdir(), "antigravity-stream-"));
	roots.push(root);
	const agentDir = join(root, "agent");
	const home = join(root, "home");
	vi.stubEnv("HOME", home);
	const sessionId = `session-${createHash("sha256").update(root).digest("hex").slice(0, 8)}`;
	const stream = createAntigravityStream({
		resolveExecutable: () => fixture,
		loadSettings: () => ({ enabled: true, resumeMode: "auto" }),
		agentDir,
		homeDir: home,
		permissionRulePresent: () => permission,
	});
	return {
		agentDir,
		sessionId,
		stream,
		run: (value) => stream(model, value, { streamKind: "main", sessionId }).result(),
		sessionDir: () => {
			const session = getSession(sessionId);
			if (session !== undefined) return session.workspace.dir;
			const name = createHash("sha256").update(sessionId, "utf8").digest("hex").slice(0, 16);
			return join(agentDir, "antigravity-subscription", "workspaces", name);
		},
	};
}

function context(messages: Message[], tools: Context["tools"] = []): Context {
	return { systemPrompt: "Use senpi tools.", messages, tools };
}

function user(content: string): UserMessage {
	return { role: "user", content, timestamp: 1 };
}

function text(message: AssistantMessage): string {
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

type LogRow = { readonly argv?: unknown[]; readonly stdin?: string };

async function logRows(dir: string): Promise<LogRow[]> {
	const content = await readFile(join(dir, ".fake-agy-log.ndjson"), "utf8");
	return content
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as LogRow);
}

function hasArgv(row: LogRow): row is LogRow & { readonly argv: unknown[] } {
	return Array.isArray(row.argv);
}

function waitForLog(dir: string, marker: string): Promise<void> {
	const path = join(dir, ".fake-agy-log.ndjson");
	return new Promise((resolve, reject) => {
		const deadline = setTimeout(() => {
			watcher.close();
			reject(new Error(`timed out waiting for ${marker}`));
		}, 8_000);
		const inspect = async (): Promise<void> => {
			try {
				if ((await readFile(path, "utf8")).includes(marker)) {
					clearTimeout(deadline);
					watcher.close();
					resolve();
				}
			} catch (error) {
				if (!isMissing(error)) {
					clearTimeout(deadline);
					watcher.close();
					reject(error);
				}
			}
		};
		const watcher = watch(dir, () => void inspect());
		void inspect();
	});
}

function isMissing(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
