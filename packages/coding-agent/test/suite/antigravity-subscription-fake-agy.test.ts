import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	AGENT_NAME,
	BRIDGE_SERVER_NAME,
} from "../../src/core/extensions/builtin/antigravity-subscription/constants.ts";
import { STATIC_AGY_MODELS } from "../../src/core/extensions/builtin/antigravity-subscription/models.ts";

const fixturePath = fileURLToPath(new URL("../fixtures/antigravity-subscription/fake-agy.mjs", import.meta.url));
const TOKEN = "test-token";
const USAGE = {
	input_tokens: 10,
	output_tokens: 5,
	thinking_tokens: 0,
	cache_read_tokens: 0,
	total_tokens: 15,
};

type JsonRecord = Record<string, unknown>;

type HeldCall = {
	readonly name: string;
	readonly args: unknown;
	readonly authorization: string | undefined;
	release(text: string): void;
};

type McpStub = {
	readonly url: string;
	readonly methods: string[];
	readonly calls: HeldCall[];
	waitForCall(index: number): Promise<HeldCall>;
	close(): Promise<void>;
};

type Resident = {
	readonly child: ChildProcess;
	readonly cwd: string;
	readonly events: unknown[];
	readonly stderr: string;
	send(value: string | JsonRecord): void;
	closeStdin(): void;
	waitFor(predicate: (events: readonly unknown[]) => boolean): Promise<void>;
	exited: Promise<number | null>;
};

const children: ChildProcess[] = [];
const directories: string[] = [];
const closers: Array<() => Promise<void>> = [];
const exits: Array<Promise<number | null>> = [];

afterEach(async () => {
	for (const child of children.splice(0)) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
	await Promise.all(exits.splice(0));
	await Promise.all(closers.splice(0).map((close) => close()));
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("fake agy fixture", () => {
	it("is executable", () => {
		expect(statSync(fixturePath).mode & 0o111).not.toBe(0);
	});

	it("lists models as slug and label lines", async () => {
		const cwd = makeTempDir();
		const result = await runToCompletion(cwd, ["models"]);
		const lines = result.stdout.split("\n").filter((line) => line.length > 0);

		expect(result.status).toBe(0);
		expect(result.stdout.startsWith("Fetching available models...\n")).toBe(true);
		expect(lines.slice(1)).toEqual(STATIC_AGY_MODELS.map((model) => `${model.id}\t${model.label}`));
		expect(readLog(cwd)[0]).toEqual({ argv: ["models"] });
	});

	it("splits an ECHO turn into two deltas and a success result", async () => {
		const cwd = makeTempDir();
		const args = residentArgs(["--model", "gemini-3.8-flash-low"]);
		const resident = spawnResident(cwd, args);
		await resident.waitFor((events) => events.length > 0);
		resident.send({ event: "user", message: { content: "ECHO:abcd" } });
		resident.closeStdin();

		expect(await resident.exited).toBe(0);
		const conversationId = initConversation(resident.events);
		expect(resident.events).toEqual([
			{
				event: "init",
				conversation_id: conversationId,
				init: {
					cwd,
					tools: ["call_mcp_tool"],
					permission_mode: "request-review",
					agent: AGENT_NAME,
					model: "gemini-3.8-flash-low",
				},
			},
			step(conversationId, 1, { state: "DONE", step_type: "user_input" }),
			step(conversationId, 2, { state: "ACTIVE", step_type: "agent_response", text_delta: "ab" }),
			step(conversationId, 3, { state: "ACTIVE", step_type: "agent_response", text_delta: "cd" }),
			step(conversationId, 4, { state: "DONE", step_type: "agent_response", usage: USAGE }),
			result(conversationId, { status: "SUCCESS", response: "abcd", num_turns: 1 }),
		]);
		expect(readLog(cwd)).toEqual([
			{ argv: args },
			{ stdin: JSON.stringify({ event: "user", message: { content: "ECHO:abcd" } }) },
		]);
	});

	it("holds tools/call until the stub releases it, then reports TOOL_RESULT", async () => {
		const cwd = makeTempDir();
		const stub = await startMcpStub();
		writeMcpConfig(cwd, stub.url);
		const resident = spawnResident(cwd, residentArgs());
		await resident.waitFor((events) => events.some((event) => isRecord(event) && event.event === "init"));

		const firstSeen = stub.waitForCall(0);
		resident.send({ event: "user", message: { content: 'CALL:read:{"path":"probe.txt"}' } });
		const first = await firstSeen;
		await resident.waitFor((events) => steps(events).some((item) => item.tool_name === "call_mcp_tool"));

		expect(first.authorization).toBe(`Bearer ${TOKEN}`);
		expect(first.name).toBe("read");
		expect(first.args).toEqual({ path: "probe.txt" });
		expect(stub.methods).toEqual([
			"server/discover",
			"initialize",
			"notifications/initialized",
			"tools/list",
			"tools/call",
		]);
		expect(concatDeltas(resident.events)).not.toContain("TOOL_RESULT");
		const active = steps(resident.events).find((item) => item.state === "ACTIVE" && item.step_type === "tool");
		expect(active?.tool_info).toEqual({
			name: "call_mcp_tool",
			parameters: {
				Arguments: { path: "probe.txt" },
				ServerName: BRIDGE_SERVER_NAME,
				ToolName: "read",
			},
		});

		first.release("held-text");
		await resident.waitFor((events) => results(events).some((item) => item.response === "TOOL_RESULT:held-text"));

		const done = steps(resident.events).find((item) => item.state === "DONE" && item.step_type === "tool");
		expect(done?.tool_info).toMatchObject({ output: "held-text" });
		expect(concatDeltas(resident.events)).toBe("TOOL_RESULT:held-text");

		const secondSeen = stub.waitForCall(1);
		resident.send({ event: "user", message: { content: 'CALL:read:{"path":"other.txt"}' } });
		const second = await secondSeen;
		expect(stub.methods.filter((method) => method === "server/discover")).toEqual(["server/discover"]);
		second.release("again");
		await resident.waitFor((events) => results(events).some((item) => item.response === "TOOL_RESULT:again"));
		resident.closeStdin();

		expect(await resident.exited).toBe(0);
	});

	it("recalls ECHO values across a --conversation restart", async () => {
		const cwd = makeTempDir();
		const first = spawnResident(cwd, residentArgs());
		await first.waitFor((events) => events.length > 0);
		const conversationId = initConversation(first.events);
		first.send({ event: "user", message: { content: "ECHO:alpha" } });
		await first.waitFor((events) => results(events).length === 1);
		first.send({ event: "user", message: { content: "ECHO:beta" } });
		await first.waitFor((events) => results(events).length === 2);
		first.closeStdin();
		expect(await first.exited).toBe(0);

		const state = JSON.parse(readFileSync(join(cwd, ".fake-agy-state", `${conversationId}.json`), "utf8")) as unknown;
		expect(state).toMatchObject({ echoes: ["alpha", "beta"] });

		const second = spawnResident(cwd, residentArgs(["--conversation", conversationId]));
		await second.waitFor((events) =>
			events.some((event) => isRecord(event) && event.conversation_id === conversationId),
		);
		second.send({ event: "user", message: { content: "RECALL" } });
		second.closeStdin();

		expect(await second.exited).toBe(0);
		expect(results(second.events).at(-1)).toMatchObject({
			conversation_id: conversationId,
			status: "SUCCESS",
			response: "alpha,beta",
		});
	});

	it("exits 1 when a stream line is missing the event field", async () => {
		const cwd = makeTempDir();
		const resident = spawnResident(cwd, residentArgs());
		await resident.waitFor((events) => events.length > 0);
		const conversationId = initConversation(resident.events);
		resident.send('{"message":{"content":"hi"}}');

		expect(await resident.exited).toBe(1);
		expect(results(resident.events).at(-1)).toEqual({
			conversation_id: conversationId,
			status: "ERROR",
			response: "",
			error: 'stream input message is missing the "event" field',
			duration_seconds: 0.01,
			num_turns: 1,
			usage: USAGE,
		});
	});

	it("exits 143 when SIGTERM arrives during HANG", async () => {
		const cwd = makeTempDir();
		const resident = spawnResident(cwd, residentArgs());
		await resident.waitFor((events) => events.length > 0);
		resident.send({ event: "user", message: { content: "HANG" } });
		await resident.waitFor((events) => steps(events).some((item) => item.step_type === "user_input"));

		expect(results(resident.events)).toEqual([]);
		resident.child.kill("SIGTERM");
		expect(await resident.exited).toBe(143);
	});

	it("rejects an unknown model before reading stdin", async () => {
		const cwd = makeTempDir();
		const resident = spawnResident(cwd, residentArgs(["--model", "not-a-real-model"]));

		expect(await resident.exited).toBe(1);
		expect(results(resident.events).at(-1)).toMatchObject({
			status: "ERROR",
			error: "unknown model: not-a-real-model",
		});
	});

	it.each([
		["AUTHFAIL", "authentication required"],
		["QUOTA", "RESOURCE_EXHAUSTED: quota exceeded (429)"],
	] as const)("exits 1 on %s", async (marker, error) => {
		const cwd = makeTempDir();
		const resident = spawnResident(cwd, residentArgs());
		await resident.waitFor((events) => events.length > 0);
		resident.send({ event: "user", message: { content: marker } });

		expect(await resident.exited).toBe(1);
		expect(results(resident.events).at(-1)).toMatchObject({ status: "ERROR", error });
	});

	it("emits a builtin run_command step before the normal response", async () => {
		const cwd = makeTempDir();
		const resident = spawnResident(cwd, residentArgs());
		await resident.waitFor((events) => events.length > 0);
		resident.send({ event: "user", message: { content: "BUILTIN" } });
		resident.closeStdin();

		expect(await resident.exited).toBe(0);
		const toolIndex = resident.events.findIndex(
			(event) => isRecord(event) && isRecord(event.step_update) && event.step_update.tool_name === "run_command",
		);
		const resultIndex = resident.events.findIndex((event) => isRecord(event) && event.event === "result");
		expect(toolIndex).toBeGreaterThan(0);
		expect(resultIndex).toBeGreaterThan(toolIndex);
		expect(results(resident.events).at(-1)).toMatchObject({ status: "SUCCESS", response: "ok" });
	});
});

function residentArgs(extra: readonly string[] = []): string[] {
	return [
		"--agent",
		AGENT_NAME,
		"--input-format",
		"stream-json",
		"--output-format",
		"stream-json",
		"--print-timeout",
		"0s",
		...extra,
	];
}

function makeTempDir(): string {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "fake-agy-")));
	directories.push(directory);
	return directory;
}

function childEnv(home: string): NodeJS.ProcessEnv {
	return {
		PATH: process.env.PATH ?? "",
		HOME: home,
		TMPDIR: home,
		LANG: "C",
		LC_ALL: "C",
	};
}

function spawnResident(cwd: string, args: readonly string[]): Resident {
	const child = spawn("node", [fixturePath, ...args], {
		cwd,
		env: childEnv(cwd),
		stdio: ["pipe", "pipe", "pipe"],
	});
	if (!child.stdout || !child.stdin || !child.stderr) throw new Error("fixture stdio was not piped");
	children.push(child);
	const events: unknown[] = [];
	const listeners = new Set<() => void>();
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdout += chunk;
		let newline = stdout.indexOf("\n");
		while (newline !== -1) {
			const line = stdout.slice(0, newline).replace(/\r$/, "");
			stdout = stdout.slice(newline + 1);
			if (line.trim() !== "") events.push(JSON.parse(line) as unknown);
			newline = stdout.indexOf("\n");
		}
		for (const listener of listeners) listener();
	});
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});
	const exited = new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => resolve(code));
	});
	exits.push(exited);
	return {
		child,
		cwd,
		events,
		get stderr() {
			return stderr;
		},
		send(value) {
			const line = typeof value === "string" ? value : JSON.stringify(value);
			child.stdin?.write(`${line}\n`);
		},
		closeStdin() {
			child.stdin?.end();
		},
		waitFor(predicate) {
			if (predicate(events)) return Promise.resolve();
			return new Promise((resolve, reject) => {
				const finish = (failed: boolean) => {
					listeners.delete(onEvent);
					child.off("close", onClose);
					if (failed) {
						reject(
							new Error(
								`fixture exited ${child.exitCode ?? "null"} before match\nstderr=${stderr}\nevents=${JSON.stringify(events)}`,
							),
						);
						return;
					}
					resolve();
				};
				const onEvent = () => {
					if (predicate(events)) finish(false);
				};
				const onClose = () => finish(!predicate(events));
				listeners.add(onEvent);
				child.on("close", onClose);
				if (predicate(events)) finish(false);
				else if (child.exitCode !== null || child.signalCode !== null) onClose();
			});
		},
		exited,
	};
}

function runToCompletion(cwd: string, args: readonly string[]): Promise<{ status: number | null; stdout: string }> {
	const child = spawn("node", [fixturePath, ...args], {
		cwd,
		env: childEnv(cwd),
		stdio: ["ignore", "pipe", "pipe"],
	});
	children.push(child);
	let stdout = "";
	child.stdout?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		stdout += chunk;
	});
	const exited = new Promise<{ status: number | null; stdout: string }>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (status) => resolve({ status, stdout }));
	});
	exits.push(exited.then((result) => result.status));
	return exited;
}

async function startMcpStub(): Promise<McpStub> {
	const methods: string[] = [];
	const calls: HeldCall[] = [];
	const waiters = new Set<() => void>();
	const sockets = new Set<Socket>();
	const server = createServer((request, response) => {
		void readBody(request).then((body) => handleStub(body, request, response, methods, calls, waiters));
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("MCP stub did not bind");
	const close = () =>
		new Promise<void>((resolve) => {
			for (const socket of sockets) socket.destroy();
			server.close(() => resolve());
		});
	closers.push(close);
	return {
		url: `http://127.0.0.1:${(address as AddressInfo).port}/mcp`,
		methods,
		calls,
		waitForCall(index) {
			const existing = calls[index];
			if (existing) return Promise.resolve(existing);
			return new Promise((resolve) => {
				const onPush = () => {
					const call = calls[index];
					if (!call) return;
					waiters.delete(onPush);
					resolve(call);
				};
				waiters.add(onPush);
			});
		},
		close,
	};
}

function handleStub(
	body: string,
	request: IncomingMessage,
	response: ServerResponse,
	methods: string[],
	calls: HeldCall[],
	waiters: Set<() => void>,
): void {
	const payload = JSON.parse(body) as unknown;
	if (!isRecord(payload) || typeof payload.method !== "string") {
		response.writeHead(400).end();
		return;
	}
	methods.push(payload.method);
	if (request.headers.authorization !== `Bearer ${TOKEN}`) {
		response.writeHead(401, { "content-type": "application/json" });
		response.end(
			JSON.stringify({
				jsonrpc: "2.0",
				id: payload.id ?? null,
				error: { code: -32001, message: "Unauthorized" },
			}),
		);
		return;
	}
	if (!Object.hasOwn(payload, "id")) {
		response.writeHead(202).end();
		return;
	}
	if (payload.method === "tools/call") {
		const params = isRecord(payload.params) ? payload.params : {};
		let release = (_text: string) => {};
		const released = new Promise<string>((resolve) => {
			release = resolve;
		});
		calls.push({
			name: typeof params.name === "string" ? params.name : "",
			args: params.arguments,
			authorization: request.headers.authorization,
			release,
		});
		for (const waiter of waiters) waiter();
		void released.then((text) => {
			if (response.destroyed) return;
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					jsonrpc: "2.0",
					id: payload.id,
					result: { content: [{ type: "text", text }], isError: false },
				}),
			);
		});
		return;
	}
	const result = payload.method === "tools/list" ? { tools: [] } : {};
	response.writeHead(200, { "content-type": "application/json" });
	response.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result }));
}

function readBody(request: IncomingMessage): Promise<string> {
	request.setEncoding("utf8");
	return new Promise((resolve, reject) => {
		let body = "";
		request.on("data", (chunk: string) => {
			body += chunk;
		});
		request.once("end", () => resolve(body));
		request.once("error", reject);
	});
}

function writeMcpConfig(cwd: string, url: string): void {
	const directory = join(cwd, ".agents");
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "mcp_config.json"),
		JSON.stringify({
			mcpServers: {
				[BRIDGE_SERVER_NAME]: {
					serverUrl: url,
					headers: { Authorization: `Bearer ${TOKEN}` },
				},
			},
		}),
	);
}

function readLog(cwd: string): unknown[] {
	return readFileSync(join(cwd, ".fake-agy-log.ndjson"), "utf8")
		.trim()
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as unknown);
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function initConversation(events: readonly unknown[]): string {
	const first = events[0];
	if (!isRecord(first) || typeof first.conversation_id !== "string") {
		throw new Error(`missing init conversation id: ${JSON.stringify(events)}`);
	}
	return first.conversation_id;
}

function steps(events: readonly unknown[]): JsonRecord[] {
	return events.flatMap((event) => {
		if (!isRecord(event) || !isRecord(event.step_update)) return [];
		return [event.step_update];
	});
}

function results(events: readonly unknown[]): JsonRecord[] {
	return events.flatMap((event) => {
		if (!isRecord(event) || event.event !== "result" || !isRecord(event.result)) return [];
		return [event.result];
	});
}

function concatDeltas(events: readonly unknown[]): string {
	return steps(events)
		.map((item) => (typeof item.text_delta === "string" ? item.text_delta : ""))
		.join("");
}

function step(conversationId: string, stepIndex: number, fields: JsonRecord): JsonRecord {
	return {
		event: "step_update",
		step_update: {
			conversation_id: conversationId,
			step_index: stepIndex,
			...fields,
		},
	};
}

function result(conversationId: string, fields: JsonRecord): JsonRecord {
	return {
		event: "result",
		result: {
			conversation_id: conversationId,
			duration_seconds: 0.01,
			usage: USAGE,
			...fields,
		},
	};
}
