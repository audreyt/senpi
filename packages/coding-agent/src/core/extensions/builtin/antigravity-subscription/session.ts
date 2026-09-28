import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import {
	type BridgeTool,
	newBridgeToken,
	registerBridgeSession,
	startBridgeServer,
	unregisterBridgeSession,
} from "./bridge-server.ts";
import { AGENT_NAME } from "./constants.ts";
import { agyChildEnvironment } from "./environment.ts";
import { renderMessagesAsText } from "./prompt.ts";
import { type AgyEvent, AgyStreamParser } from "./stream-parser.ts";
import { ToolCallQueue } from "./tool-bridge.ts";
import {
	type PreparedSessionWorkspace,
	prepareSessionWorkspace,
	removeSessionWorkspace,
	sessionWorkspaceRoot,
} from "./workspace.ts";

const IDLE_TIMEOUT_MS = 30 * 60_000;
const REAPER_INTERVAL_MS = 60_000;
const MAX_RESIDENT_SESSIONS = 32;
const STDERR_TAIL_BYTES = 16 * 1024;
const KILL_GRACE_MS = 5_000;

export type AgyProcessExit = {
	readonly type: "exit";
	readonly code: number | null;
};

export type AgySessionEvent = AgyEvent | AgyProcessExit;

export type AgySessionBinding = {
	readonly conversationId: string;
	readonly syncedCount: number;
	readonly prefixDigest: string;
	readonly modelId: string;
};

export type SeedBindingInput = AgySessionBinding;

export type PreparedAgySession = {
	readonly key: string;
	readonly bridgeUrl: string;
	readonly token: string;
	readonly workspace: PreparedSessionWorkspace;
};

export type StartAgySessionInput = {
	readonly prepared: PreparedAgySession;
	readonly executable: string;
	readonly modelId: string;
	readonly conversationId?: string;
	readonly tools: readonly BridgeTool[];
};

export type PrepareAgySessionInput = {
	readonly key: string;
	readonly agentDir: string;
	readonly systemPrompt: string;
	readonly projectCwd: string;
};

export type ContinuityDecision = "resolve-tools" | "delta" | "reattach" | "bootstrap";

export type DecideContinuityInput = {
	readonly live: boolean;
	readonly modelMatches: boolean;
	readonly fingerprintMatches: boolean;
	readonly conversationId?: string;
	readonly syncedCount: number;
	readonly messageCount: number;
	readonly storedPrefixDigest: string;
	readonly currentPrefixDigest: string;
	readonly resumeMode: "auto" | "off";
	readonly hasPendingCalls: boolean;
	readonly beginsWithPendingToolResult: boolean;
};

type QueueWaiter = {
	readonly resolve: () => void;
	readonly reject: (error: Error) => void;
	readonly signal?: AbortSignal;
	readonly onAbort: () => void;
};

class SessionEventQueue {
	readonly #events: AgySessionEvent[] = [];
	readonly #waiters: QueueWaiter[] = [];

	push(event: AgySessionEvent): void {
		this.#events.push(event);
		for (const waiter of this.#waiters.splice(0)) {
			waiter.signal?.removeEventListener("abort", waiter.onAbort);
			if (waiter.signal?.aborted) {
				waiter.reject(abortError(waiter.signal));
				continue;
			}
			waiter.resolve();
		}
	}

	whenAvailable(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) return Promise.reject(abortError(signal));
		if (this.#events.length > 0) return Promise.resolve();
		return new Promise<void>((resolve, reject) => {
			const waiter: QueueWaiter = {
				resolve,
				reject,
				signal,
				onAbort: () => {
					const index = this.#waiters.indexOf(waiter);
					if (index < 0) return;
					this.#waiters.splice(index, 1);
					reject(abortError(signal));
				},
			};
			this.#waiters.push(waiter);
			signal?.addEventListener("abort", waiter.onAbort, { once: true });
		});
	}

	shift(): AgySessionEvent | undefined {
		return this.#events.shift();
	}
}

export type AgySession = {
	readonly key: string;
	readonly process: ChildProcessWithoutNullStreams;
	readonly events: SessionEventQueue;
	readonly token: string;
	readonly queue: ToolCallQueue;
	readonly workspace: PreparedSessionWorkspace;
	readonly bridgeUrl: string;
	conversationId: string | undefined;
	modelId: string;
	fingerprint: string;
	tools: BridgeTool[];
	syncedCount: number;
	prefixDigest: string;
	lastUsedAt: number;
	turnActive: boolean;
	exited: boolean;
	exitCode: number | null;
	stderrTail: string;
	killTimer: ReturnType<typeof setTimeout> | undefined;
};

const sessions = new Map<string, AgySession>();
const bindings = new Map<string, AgySessionBinding>();
let reaper: ReturnType<typeof setInterval> | undefined;

export function decideContinuity(input: DecideContinuityInput): ContinuityDecision {
	if (input.hasPendingCalls && input.beginsWithPendingToolResult) return "resolve-tools";
	const prefixMatches =
		input.syncedCount > 0 &&
		input.messageCount >= input.syncedCount &&
		input.storedPrefixDigest === input.currentPrefixDigest;
	if (input.live && input.modelMatches && input.fingerprintMatches && prefixMatches) return "delta";
	if (input.conversationId !== undefined && input.resumeMode === "auto" && prefixMatches) return "reattach";
	return "bootstrap";
}

export function messagePrefixDigest(messages: readonly Message[]): string {
	return createHash("sha256").update(renderMessagesAsText(messages), "utf8").digest("hex");
}

export function getSession(key: string): AgySession | undefined {
	return sessions.get(key);
}

export function getBinding(key: string): AgySessionBinding | undefined {
	const live = sessions.get(key);
	if (live?.conversationId !== undefined) {
		return {
			conversationId: live.conversationId,
			syncedCount: live.syncedCount,
			prefixDigest: live.prefixDigest,
			modelId: live.modelId,
		};
	}
	return bindings.get(key);
}

export async function prepareAgySession(input: PrepareAgySessionInput): Promise<PreparedAgySession> {
	const bridge = await startBridgeServer();
	const live = sessions.get(input.key);
	const token = live?.token ?? newBridgeToken();
	const workspace = prepareSessionWorkspace({
		rootDir: sessionWorkspaceRoot(input.agentDir),
		sessionKey: input.key,
		systemPrompt: input.systemPrompt,
		projectCwd: input.projectCwd,
		bridgeUrl: bridge.url,
		token,
	});
	return { key: input.key, bridgeUrl: bridge.url, token, workspace };
}

export function startAgySession(input: StartAgySessionInput): AgySession {
	const prior = sessions.get(input.prepared.key);
	if (prior !== undefined) closeSession(prior.key, "replaced", { keepConversation: true });
	evictToCapacity();

	const args = [
		"--agent",
		AGENT_NAME,
		"--input-format",
		"stream-json",
		"--output-format",
		"stream-json",
		"--print-timeout",
		"0s",
		"--model",
		input.modelId,
		...(input.conversationId === undefined ? [] : ["--conversation", input.conversationId]),
	];
	const child = spawn(input.executable, args, {
		cwd: input.prepared.workspace.dir,
		env: agyChildEnvironment(),
		stdio: ["pipe", "pipe", "pipe"],
		detached: process.platform !== "win32",
	});
	const stored = bindings.get(input.prepared.key);
	const queue = new ToolCallQueue();
	const events = new SessionEventQueue();
	const session: AgySession = {
		key: input.prepared.key,
		process: child,
		events,
		token: input.prepared.token,
		queue,
		workspace: input.prepared.workspace,
		bridgeUrl: input.prepared.bridgeUrl,
		conversationId: input.conversationId ?? stored?.conversationId,
		modelId: input.modelId,
		fingerprint: input.prepared.workspace.fingerprint,
		tools: [...input.tools],
		syncedCount: stored?.syncedCount ?? 0,
		prefixDigest: stored?.prefixDigest ?? messagePrefixDigest([]),
		lastUsedAt: Date.now(),
		turnActive: false,
		exited: false,
		exitCode: null,
		stderrTail: "",
		killTimer: undefined,
	};
	sessions.set(session.key, session);
	registerBridgeSession(session.token, {
		listTools: () => session.tools,
		callTool: (name, argsValue, signal) => session.queue.enqueue(name, argsValue, signal),
	});
	wireProcess(session);
	startReaper();
	return session;
}

export function rememberSessionBinding(session: AgySession): AgySessionBinding | undefined {
	if (session.conversationId === undefined) return undefined;
	const binding = {
		conversationId: session.conversationId,
		syncedCount: session.syncedCount,
		prefixDigest: session.prefixDigest,
		modelId: session.modelId,
	};
	bindings.set(session.key, binding);
	return binding;
}

export function seedBinding(key: string, binding: SeedBindingInput): void {
	bindings.set(key, {
		conversationId: binding.conversationId,
		syncedCount: binding.syncedCount,
		prefixDigest: binding.prefixDigest,
		modelId: binding.modelId,
	});
}

export function closeSession(key: string, reason: string, options: { readonly keepConversation: boolean }): void {
	const session = sessions.get(key);
	if (session === undefined) {
		if (!options.keepConversation) bindings.delete(key);
		return;
	}
	sessions.delete(key);
	session.turnActive = false;
	if (options.keepConversation) rememberSessionBinding(session);
	else bindings.delete(key);
	unregisterBridgeSession(session.token);
	session.queue.rejectAll(reason);
	terminate(session);
	if (!options.keepConversation) {
		if (session.exited) removeSessionWorkspace(session.workspace.dir);
		else session.process.once("close", () => removeSessionWorkspace(session.workspace.dir));
	}
}

export function closeAllSessions(): void {
	for (const key of [...sessions.keys()]) closeSession(key, "session_shutdown", { keepConversation: true });
	if (reaper !== undefined) clearInterval(reaper);
	reaper = undefined;
}

export function reapIdleSessions(now = Date.now()): void {
	for (const session of sessions.values()) {
		if (!isEvictable(session) || now - session.lastUsedAt < IDLE_TIMEOUT_MS) continue;
		closeSession(session.key, "idle_timeout", { keepConversation: true });
	}
	evictToCapacity();
}

function wireProcess(session: AgySession): void {
	const parser = new AgyStreamParser();
	session.process.stdout.on("data", (chunk: Buffer) => {
		for (const event of parser.push(chunk)) session.events.push(event);
	});
	session.process.stderr.on("data", (chunk: Buffer) => {
		session.stderrTail = boundedTail(session.stderrTail, chunk);
	});
	session.process.once("error", (error) => {
		session.stderrTail = boundedTail(session.stderrTail, Buffer.from(error.message, "utf8"));
	});
	session.process.once("close", (code) => {
		for (const event of parser.flush()) session.events.push(event);
		session.exited = true;
		session.exitCode = code;
		if (session.killTimer !== undefined) clearTimeout(session.killTimer);
		session.killTimer = undefined;
		session.events.push({ type: "exit", code });
	});
}

function boundedTail(current: string, chunk: Buffer): string {
	const bytes = Buffer.concat([Buffer.from(current, "utf8"), chunk]);
	return bytes.subarray(Math.max(0, bytes.length - STDERR_TAIL_BYTES)).toString("utf8");
}

function terminate(session: AgySession): void {
	if (session.exited || session.process.pid === undefined) return;
	sendSignal(session, "SIGTERM");
	const timer = setTimeout(() => {
		if (!session.exited) sendSignal(session, "SIGKILL");
	}, KILL_GRACE_MS);
	timer.unref();
	session.killTimer = timer;
}

function sendSignal(session: AgySession, signal: NodeJS.Signals): void {
	try {
		if (process.platform === "win32" || session.process.pid === undefined) {
			session.process.kill(signal);
			return;
		}
		process.kill(-session.process.pid, signal);
	} catch (error) {
		if (!isNoSuchProcess(error)) throw error;
	}
}

function isNoSuchProcess(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}

function isEvictable(session: AgySession): boolean {
	return !session.turnActive && session.queue.size === 0;
}

function evictToCapacity(): void {
	while (sessions.size >= MAX_RESIDENT_SESSIONS) {
		const candidate = [...sessions.values()]
			.filter(isEvictable)
			.sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
		if (candidate === undefined) return;
		closeSession(candidate.key, "lru_evicted", { keepConversation: true });
	}
}

function startReaper(): void {
	if (reaper !== undefined) return;
	reaper = setInterval(() => reapIdleSessions(), REAPER_INTERVAL_MS);
	reaper.unref();
}

function abortError(signal: AbortSignal | undefined): Error {
	return signal?.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}
