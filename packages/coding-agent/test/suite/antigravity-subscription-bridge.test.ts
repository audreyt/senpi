import { request as httpRequest } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	type BridgeCallResult,
	type BridgeSessionHandlers,
	newBridgeToken,
	registerBridgeSession,
	startBridgeServer,
	stopBridgeServer,
	unregisterBridgeSession,
} from "../../src/core/extensions/builtin/antigravity-subscription/bridge-server.ts";
import { ToolCallQueue } from "../../src/core/extensions/builtin/antigravity-subscription/tool-bridge.ts";

const tools = [
	{
		name: "read",
		description: "Read a file",
		inputSchema: { type: "object", properties: { path: { type: "string" } } },
	},
];
const successResult: BridgeCallResult = {
	content: [{ type: "text", text: "done" }],
	isError: false,
};
const registeredTokens: string[] = [];
let bridgeUrl = "";
let startupUrls: readonly string[] = [];

beforeAll(async () => {
	const starts = await Promise.all([startBridgeServer(), startBridgeServer()]);
	startupUrls = starts.map((start) => start.url);
	bridgeUrl = starts[0]?.url ?? "";
});

afterEach(() => {
	for (const token of registeredTokens.splice(0)) unregisterBridgeSession(token);
});

afterAll(async () => {
	await stopBridgeServer();
});

describe("Antigravity MCP bridge server", () => {
	it("shares one lazy server across concurrent starts", () => {
		expect(startupUrls).toHaveLength(2);
		expect(startupUrls[0]).toBe(startupUrls[1]);
		expect(bridgeUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
	});

	it("returns 401 without a bearer token", async () => {
		const response = await fetch(bridgeUrl, {
			method: "POST",
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover" }),
		});
		const body: unknown = await response.json();

		expect(response.status).toBe(401);
		expect(body).toEqual({
			jsonrpc: "2.0",
			id: null,
			error: { code: -32001, message: "Unauthorized" },
		});
	});

	it("returns 401 for an unregistered bearer token", async () => {
		const response = await postJson(newBridgeToken(), { jsonrpc: "2.0", id: 2, method: "server/discover" });

		expect(response.status).toBe(401);
	});

	it("discovers the server with an empty result", async () => {
		const token = register(defaultHandlers());
		const response = await postJson(token, {
			jsonrpc: "2.0",
			id: 3,
			method: "server/discover",
		});
		const body: unknown = await response.json();

		expect(body).toEqual({ jsonrpc: "2.0", id: 3, result: {} });
	});

	it("echoes the initialize protocol version", async () => {
		const token = register(defaultHandlers());
		const response = await postJson(token, {
			jsonrpc: "2.0",
			id: 4,
			method: "initialize",
			params: { protocolVersion: "2025-11-25" },
		});
		const body: unknown = await response.json();

		expect(body).toEqual({
			jsonrpc: "2.0",
			id: 4,
			result: {
				protocolVersion: "2025-11-25",
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: "senpi-host", version: "1" },
			},
		});
	});

	it("returns 202 for notifications", async () => {
		const token = register(defaultHandlers());
		const responses = await Promise.all([
			postJson(token, { jsonrpc: "2.0", method: "notifications/initialized" }),
			postJson(token, { jsonrpc: "2.0", method: "notifications/roots/list_changed" }),
		]);

		expect(responses.map((response) => response.status)).toEqual([202, 202]);
		expect(await Promise.all(responses.map((response) => response.text()))).toEqual(["", ""]);
	});

	it("returns 405 for GET", async () => {
		const token = register(defaultHandlers());
		const response = await fetch(bridgeUrl, {
			headers: { authorization: `Bearer ${token}` },
		});

		expect(response.status).toBe(405);
	});

	it("returns 204 for DELETE", async () => {
		const token = register(defaultHandlers());
		const response = await fetch(bridgeUrl, {
			method: "DELETE",
			headers: { authorization: `Bearer ${token}` },
		});

		expect(response.status).toBe(204);
		expect(await response.text()).toBe("");
	});

	it("lists the registered session tools", async () => {
		const token = register(defaultHandlers());
		const response = await postJson(token, {
			jsonrpc: "2.0",
			id: 5,
			method: "tools/list",
		});
		const body: unknown = await response.json();

		expect(body).toEqual({ jsonrpc: "2.0", id: 5, result: { tools } });
	});

	it("holds a tool call until its handler resolves", async () => {
		const called = deferred<{
			readonly name: string;
			readonly args: Record<string, unknown>;
			readonly signal: AbortSignal;
		}>();
		const release = deferred<BridgeCallResult>();
		const token = register({
			listTools: () => tools,
			callTool: (name, args, signal) => {
				called.resolve({ name, args, signal });
				return release.promise;
			},
		});
		const responsePromise = postJson(token, {
			jsonrpc: "2.0",
			id: 6,
			method: "tools/call",
			params: { name: "read", arguments: { path: "probe.txt" } },
		});
		const call = await called.promise;
		let settled = false;
		void responsePromise.then(() => {
			settled = true;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(call).toMatchObject({ name: "read", args: { path: "probe.txt" } });
		expect(call.signal.aborted).toBe(false);
		expect(settled).toBe(false);

		release.resolve(successResult);
		const response = await responsePromise;
		const body: unknown = await response.json();
		expect(body).toEqual({ jsonrpc: "2.0", id: 6, result: successResult });
	});

	it("converts handler throws into tool error results", async () => {
		const token = register({
			listTools: () => tools,
			callTool: () => {
				throw new Error("tool exploded");
			},
		});
		const response = await postJson(token, {
			jsonrpc: "2.0",
			id: 7,
			method: "tools/call",
			params: { name: "read" },
		});
		const body: unknown = await response.json();

		expect(body).toEqual({
			jsonrpc: "2.0",
			id: 7,
			result: {
				content: [{ type: "text", text: "tool exploded" }],
				isError: true,
			},
		});
	});

	it("aborts the handler when the HTTP client disconnects", async () => {
		const started = deferred<AbortSignal>();
		const aborted = deferred<void>();
		const token = register(abortAwareHandlers(started, aborted));
		const controller = new AbortController();
		const responsePromise = postJson(
			token,
			{
				jsonrpc: "2.0",
				id: 8,
				method: "tools/call",
				params: { name: "read" },
			},
			controller.signal,
		);
		const handlerSignal = await started.promise;
		const rejected = expect(responsePromise).rejects.toMatchObject({ name: "AbortError" });

		controller.abort();
		await aborted.promise;

		expect(handlerSignal.aborted).toBe(true);
		await rejected;
	});

	it("aborts in-flight handlers when their session unregisters", async () => {
		const started = deferred<AbortSignal>();
		const aborted = deferred<void>();
		const token = register(abortAwareHandlers(started, aborted));
		const responsePromise = postJson(token, {
			jsonrpc: "2.0",
			id: 9,
			method: "tools/call",
			params: { name: "read" },
		});
		const handlerSignal = await started.promise;

		unregisterBridgeSession(token);
		await aborted.promise;

		expect(handlerSignal.aborted).toBe(true);
		expect((await responsePromise).status).toBe(200);
	});

	it("does not invoke a session unregistered during body upload", async () => {
		let callCount = 0;
		const token = register({
			listTools: () => tools,
			callTool: () => {
				callCount++;
				return Promise.resolve(successResult);
			},
		});
		const response = await postJsonInTwoParts(
			token,
			{
				jsonrpc: "2.0",
				id: 10,
				method: "tools/call",
				params: { name: "read" },
			},
			() => unregisterBridgeSession(token),
		);
		const body: unknown = JSON.parse(response.body);

		expect(response.statusCode).toBe(401);
		expect(body).toMatchObject({ error: { code: -32001 } });
		expect(callCount).toBe(0);
	});

	it("returns parse and method errors as JSON-RPC", async () => {
		const token = register(defaultHandlers());
		const parseResponse = await fetch(bridgeUrl, {
			method: "POST",
			headers: { authorization: `Bearer ${token}` },
			body: "{",
		});
		const methodResponse = await postJson(token, {
			jsonrpc: "2.0",
			id: 10,
			method: "unknown",
		});
		const parseBody: unknown = await parseResponse.json();
		const methodBody: unknown = await methodResponse.json();

		expect(parseResponse.status).toBe(400);
		expect(parseBody).toMatchObject({ error: { code: -32700 } });
		expect(methodBody).toMatchObject({ id: 10, error: { code: -32601 } });
	});

	it("rejects request bodies over 16 MiB", async () => {
		const token = register(defaultHandlers());
		const response = await fetch(bridgeUrl, {
			method: "POST",
			headers: { authorization: `Bearer ${token}` },
			body: "x".repeat(16 * 1024 * 1024 + 1),
		});

		expect(response.status).toBe(413);
	});

	it("aborts in-flight handlers when the server stops", async () => {
		const started = deferred<AbortSignal>();
		const aborted = deferred<void>();
		const token = register(abortAwareHandlers(started, aborted));
		const responsePromise = postJson(token, {
			jsonrpc: "2.0",
			id: 11,
			method: "tools/call",
			params: { name: "read" },
		});
		const disconnected = responsePromise.catch((error: unknown) => error);
		const handlerSignal = await started.promise;

		const stopping = stopBridgeServer();
		await aborted.promise;
		const disconnectError = await disconnected;
		await stopping;

		expect(handlerSignal.aborted).toBe(true);
		expect(disconnectError).toMatchObject({ name: "TypeError" });
		bridgeUrl = (await startBridgeServer()).url;
	});
});

describe("ToolCallQueue", () => {
	it("hands out calls in FIFO order with agy UUID ids", async () => {
		const queue = new ToolCallQueue();
		const firstResult = queue.enqueue("first", { order: 1 }, new AbortController().signal);
		const secondResult = queue.enqueue("second", { order: 2 }, new AbortController().signal);

		expect(queue.size).toBe(2);
		expect(queue.hasUnclaimed()).toBe(true);
		const first = queue.takeUnclaimed();
		const second = queue.takeUnclaimed();
		if (first === undefined || second === undefined) throw new Error("missing queued calls");

		expect([first.name, second.name]).toEqual(["first", "second"]);
		expect(first.toolCallId).toMatch(/^agy_[0-9a-f-]{36}$/);
		expect(second.toolCallId).not.toBe(first.toolCallId);
		expect(queue.hasUnclaimed()).toBe(false);
		expect(queue.isPending(first.toolCallId)).toBe(true);

		expect(queue.resolve(first.toolCallId, successResult)).toBe(true);
		expect(queue.resolve(second.toolCallId, successResult)).toBe(true);
		await expect(firstResult).resolves.toEqual(successResult);
		await expect(secondResult).resolves.toEqual(successResult);
		expect(queue.size).toBe(0);
		expect(queue.resolve(first.toolCallId, successResult)).toBe(false);
	});

	it("resolves a waiting consumer when a call arrives", async () => {
		const queue = new ToolCallQueue();
		const available = queue.whenUnclaimed();
		const result = queue.enqueue("later", { ready: true }, new AbortController().signal);
		await available;
		const call = queue.takeUnclaimed();
		if (call === undefined) throw new Error("missing queued call");

		expect(call).toMatchObject({ name: "later", args: { ready: true } });
		queue.resolve(call.toolCallId, successResult);
		await expect(result).resolves.toEqual(successResult);
	});

	it("removes and rejects an enqueued call when aborted", async () => {
		const queue = new ToolCallQueue();
		const controller = new AbortController();
		const result = queue.enqueue("cancelled", {}, controller.signal);

		controller.abort();

		await expect(result).rejects.toMatchObject({ name: "AbortError" });
		expect(queue.size).toBe(0);
		expect(queue.hasUnclaimed()).toBe(false);
	});

	it("rejects an aborted readiness waiter without consuming a later call", async () => {
		const queue = new ToolCallQueue();
		const controller = new AbortController();
		const available = queue.whenUnclaimed(controller.signal);
		controller.abort();

		await expect(available).rejects.toMatchObject({ name: "AbortError" });
		const result = queue.enqueue("survivor", {}, new AbortController().signal);
		const call = queue.takeUnclaimed();
		if (call === undefined) throw new Error("missing queued call");
		expect(call.name).toBe("survivor");
		queue.resolve(call.toolCallId, successResult);
		await result;
	});

	it("settles every claimed and unclaimed call through rejectAll", async () => {
		const queue = new ToolCallQueue();
		const firstResult = queue.enqueue("first", {}, new AbortController().signal);
		const secondResult = queue.enqueue("second", {}, new AbortController().signal);
		const first = queue.takeUnclaimed();
		if (first === undefined) throw new Error("missing queued call");

		queue.rejectAll("session closed");

		const expected: BridgeCallResult = {
			content: [{ type: "text", text: "session closed" }],
			isError: true,
		};
		await expect(firstResult).resolves.toEqual(expected);
		await expect(secondResult).resolves.toEqual(expected);
		expect(queue.size).toBe(0);
		expect(queue.resolve(first.toolCallId, successResult)).toBe(false);
	});
});

function register(handlers: BridgeSessionHandlers): string {
	const token = newBridgeToken();
	registeredTokens.push(token);
	registerBridgeSession(token, handlers);
	return token;
}

function defaultHandlers(): BridgeSessionHandlers {
	return {
		listTools: () => tools,
		callTool: () => Promise.resolve(successResult),
	};
}

function abortAwareHandlers(
	started: ReturnType<typeof deferred<AbortSignal>>,
	aborted: ReturnType<typeof deferred<void>>,
): BridgeSessionHandlers {
	return {
		listTools: () => tools,
		callTool: (_name, _args, signal) => {
			started.resolve(signal);
			return new Promise((resolve) => {
				signal.addEventListener(
					"abort",
					() => {
						aborted.resolve();
						resolve({
							content: [{ type: "text", text: "aborted" }],
							isError: true,
						});
					},
					{ once: true },
				);
			});
		},
	};
}

function postJson(token: string, payload: unknown, signal?: AbortSignal): Promise<Response> {
	return fetch(bridgeUrl, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
		},
		body: JSON.stringify(payload),
		signal,
	});
}

function postJsonInTwoParts(
	token: string,
	payload: unknown,
	afterFirstPart: () => void,
): Promise<{ readonly statusCode: number | undefined; readonly body: string }> {
	const body = JSON.stringify(payload);
	const split = Math.floor(body.length / 2);
	return new Promise((resolve, reject) => {
		const request = httpRequest(bridgeUrl, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
				"content-length": String(body.length),
				expect: "100-continue",
			},
		});
		request.on("continue", () => {
			request.write(body.slice(0, split), () => {
				afterFirstPart();
				request.end(body.slice(split));
			});
		});
		request.on("response", (response) => {
			let responseBody = "";
			response.setEncoding("utf8");
			response.on("data", (chunk: string) => {
				responseBody += chunk;
			});
			response.on("end", () => {
				resolve({ statusCode: response.statusCode, body: responseBody });
			});
		});
		request.on("error", reject);
		request.flushHeaders();
	});
}

function deferred<T>(): {
	readonly promise: Promise<T>;
	readonly resolve: (value: T | PromiseLike<T>) => void;
} {
	let resolvePromise: (value: T | PromiseLike<T>) => void = () => {};
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}
