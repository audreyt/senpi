#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const USAGE = {
	input_tokens: 10,
	output_tokens: 5,
	thinking_tokens: 0,
	cache_read_tokens: 0,
	total_tokens: 15,
};

const MODELS = [
	["gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"],
	["gemini-3.8-flash-medium", "Gemini 3.8 Flash (Medium)"],
	["gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)"],
	["gemini-3.7-flash-high", "Gemini 3.7 Flash (High)"],
	["gemini-3.7-flash-medium", "Gemini 3.7 Flash (Medium)"],
	["gemini-3.7-flash-low", "Gemini 3.7 Flash (Low)"],
	["gemini-3.6-flash-high", "Gemini 3.6 Flash (High)"],
	["gemini-3.6-flash-medium", "Gemini 3.6 Flash (Medium)"],
	["gemini-3.6-flash-low", "Gemini 3.6 Flash (Low)"],
	["gemini-3.1-pro-high", "Gemini 3.1 Pro (High)"],
	["gemini-3.1-pro-low", "Gemini 3.1 Pro (Low)"],
	["claude-sonnet-4-6", "Claude Sonnet 4.6 (Thinking)"],
	["claude-opus-4-6-thinking", "Claude Opus 4.6 (Thinking)"],
	["gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"],
];

const MODEL_IDS = new Set(MODELS.map(([id]) => id));
const MISSING_EVENT_ERROR = 'stream input message is missing the "event" field';

let conversationId = "";
let stepIndex = 0;
let state = { echoes: [], turns: 0 };
let handshake;
let hanging = false;
let exiting = false;
let queue = Promise.resolve();

process.on("SIGTERM", () => {
	exiting = true;
	process.exit(143);
});

await main();

async function main() {
	const argv = process.argv.slice(2);
	appendLog({ argv });
	const args = parseArgs(argv);
	if (args.command === "models") {
		const listing = `Fetching available models...\n${MODELS.map(([id, label]) => `${id}\t${label}`).join("\n")}\n`;
		await writeStdout(listing);
		process.exit(0);
	}

	conversationId = args.conversation ?? randomUUID();
	state = loadState(conversationId);
	await emitInit(args);
	if (args.model !== undefined && !MODEL_IDS.has(args.model)) {
		await emitResult("ERROR", "", `unknown model: ${args.model}`);
		process.exit(1);
	}
	startResident();
}

function parseArgs(argv) {
	let command;
	let model;
	let conversation;
	let agent = "senpi-host";
	const positionals = [];
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--model" || arg === "--conversation" || arg === "--agent") {
			const value = argv[index + 1];
			index += 1;
			if (arg === "--model") model = value;
			else if (arg === "--conversation") conversation = value;
			else if (value) agent = value;
			continue;
		}
		if (arg.startsWith("--model=")) {
			model = arg.slice("--model=".length);
			continue;
		}
		if (arg.startsWith("--conversation=")) {
			conversation = arg.slice("--conversation=".length);
			continue;
		}
		if (arg.startsWith("--agent=")) {
			agent = arg.slice("--agent=".length);
			continue;
		}
		if (arg === "--input-format" || arg === "--output-format" || arg === "--print-timeout") {
			index += 1;
			continue;
		}
		if (
			arg.startsWith("--input-format=") ||
			arg.startsWith("--output-format=") ||
			arg.startsWith("--print-timeout=")
		) {
			continue;
		}
		if (!arg.startsWith("-")) positionals.push(arg);
	}
	if (positionals[0] === "models") command = "models";
	return { command, model, conversation, agent };
}

function startResident() {
	const lines = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
	lines.on("line", (line) => {
		appendLog({ stdin: line });
		queue = queue.then(() => handleLine(line)).catch((error) => failTurn(error));
	});
	lines.on("close", () => {
		if (hanging || exiting) return;
		queue = queue.then(() => {
			if (!exiting) process.exit(0);
		});
	});
}

async function handleLine(line) {
	if (line.trim() === "") return;
	let parsed;
	try {
		parsed = JSON.parse(line);
	} catch {
		await emitResult("ERROR", "", "invalid json");
		exitProcess(1);
		return;
	}
	if (!isRecord(parsed) || typeof parsed.event !== "string" || parsed.event === "") {
		await emitResult("ERROR", "", MISSING_EVENT_ERROR);
		exitProcess(1);
		return;
	}
	if (parsed.event !== "user") {
		await emitResult("ERROR", "", `unsupported stream input event "${parsed.event}"`);
		return;
	}
	const message = isRecord(parsed.message) ? parsed.message : undefined;
	const content = typeof message?.content === "string" ? message.content : "";
	await emitStep({ state: "DONE", step_type: "user_input" });
	await runScript(content);
}

async function runScript(content) {
	if (content.includes("AUTHFAIL")) {
		await emitResult("ERROR", "", "authentication required");
		exitProcess(1);
		return;
	}
	if (content.includes("QUOTA")) {
		await emitResult("ERROR", "", "RESOURCE_EXHAUSTED: quota exceeded (429)");
		exitProcess(1);
		return;
	}
	if (content.includes("HANG")) {
		hanging = true;
		// A pending promise does not keep Node alive after stdin closes. The interval only
		// holds the process until SIGTERM; it is not a timed wait.
		setInterval(() => {}, 1 << 30);
		await new Promise(() => {});
		return;
	}
	if (content.includes("CALL:")) {
		await runCall(content);
		return;
	}
	if (content.includes("MANAGE_TASK")) {
		await emitStep({
			state: "DONE",
			step_type: "tool",
			tool_name: "manage_task",
			tool_info: { name: "manage_task", parameters: {} },
		});
		await respondText("task-noted");
		return;
	}
	if (content.includes("BUILTIN")) {
		await emitStep({
			state: "ACTIVE",
			step_type: "tool",
			tool_name: "run_command",
			tool_info: { name: "run_command", parameters: {} },
		});
		await respondText("ok");
		return;
	}
	if (content.includes("ECHO:")) {
		const value = content.slice(content.indexOf("ECHO:") + "ECHO:".length);
		state.echoes.push(value);
		saveState();
		await respondText(value);
		return;
	}
	if (content.includes("RECALL")) {
		await respondText(state.echoes.join(","));
		return;
	}
	await respondText(content);
}

async function runCall(content) {
	const marker = content.indexOf("CALL:");
	const rest = content.slice(marker + "CALL:".length);
	const splitAt = rest.indexOf(":");
	if (splitAt <= 0) {
		await emitResult("ERROR", "", "invalid CALL marker");
		return;
	}
	const toolName = rest.slice(0, splitAt);
	let args;
	try {
		args = JSON.parse(rest.slice(splitAt + 1));
	} catch {
		await emitResult("ERROR", "", "invalid CALL json");
		return;
	}
	const server = await ensureHandshake();
	const parameters = {
		Arguments: args,
		ServerName: server.name,
		ToolName: toolName,
	};
	await emitStep({
		state: "ACTIVE",
		step_type: "tool",
		tool_name: "call_mcp_tool",
		tool_info: { name: "call_mcp_tool", parameters },
	});
	const response = await postJson(server, {
		jsonrpc: "2.0",
		id: server.nextId(),
		method: "tools/call",
		params: { name: toolName, arguments: args },
	});
	const output = firstText(response);
	await emitStep({
		state: "DONE",
		step_type: "tool",
		tool_name: "call_mcp_tool",
		tool_info: { name: "call_mcp_tool", parameters, output },
	});
	await respondText(`TOOL_RESULT:${output}`);
}

function ensureHandshake() {
	if (!handshake) {
		handshake = doHandshake().catch((error) => {
			handshake = undefined;
			throw error;
		});
	}
	return handshake;
}

async function doHandshake() {
	const server = readMcpServer();
	await postJson(server, { jsonrpc: "2.0", id: server.nextId(), method: "server/discover" });
	await postJson(server, {
		jsonrpc: "2.0",
		id: server.nextId(),
		method: "initialize",
		params: {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "fake-agy", version: "1.0.0" },
		},
	});
	await postJson(server, { jsonrpc: "2.0", method: "notifications/initialized" });
	await postJson(server, { jsonrpc: "2.0", id: server.nextId(), method: "tools/list" });
	return server;
}

function readMcpServer() {
	const file = join(process.cwd(), ".agents", "mcp_config.json");
	const parsed = JSON.parse(readFileSync(file, "utf8"));
	if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
		throw new Error("mcp config is missing mcpServers");
	}
	const servers = parsed.mcpServers;
	const name = isRecord(servers["senpi-host"]) ? "senpi-host" : Object.keys(servers)[0];
	const server = name === undefined ? undefined : servers[name];
	if (!isRecord(server) || typeof server.serverUrl !== "string") {
		throw new Error("mcp config is missing serverUrl");
	}
	const headers = isRecord(server.headers) ? server.headers : {};
	let rpcId = 0;
	return {
		name: name ?? "senpi-host",
		url: server.serverUrl,
		headers,
		nextId: () => {
			rpcId += 1;
			return rpcId;
		},
	};
}

async function postJson(server, payload) {
	const headers = {
		accept: "application/json, text/event-stream",
		"content-type": "application/json",
	};
	for (const [key, value] of Object.entries(server.headers)) {
		if (typeof value === "string") headers[key] = value;
	}
	const response = await fetch(server.url, {
		method: "POST",
		headers,
		body: JSON.stringify(payload),
	});
	const text = await response.text();
	if (response.status >= 400) {
		throw new Error(`MCP ${String(payload.method)} HTTP ${response.status}`);
	}
	if (text === "") return undefined;
	const parsed = JSON.parse(text);
	if (isRecord(parsed) && parsed.error !== undefined) {
		const error = isRecord(parsed.error) ? parsed.error.message : parsed.error;
		throw new Error(typeof error === "string" ? error : "MCP error");
	}
	return parsed;
}

function firstText(body) {
	if (!isRecord(body) || !isRecord(body.result) || !Array.isArray(body.result.content)) return "";
	for (const item of body.result.content) {
		if (isRecord(item) && item.type === "text" && typeof item.text === "string") return item.text;
	}
	return "";
}

async function respondText(text) {
	const mid = Math.ceil(text.length / 2);
	await emitStep({ state: "ACTIVE", step_type: "agent_response", text_delta: text.slice(0, mid) });
	await emitStep({ state: "ACTIVE", step_type: "agent_response", text_delta: text.slice(mid) });
	await emitStep({ state: "DONE", step_type: "agent_response", usage: USAGE });
	await emitResult("SUCCESS", text);
}

async function emitInit(args) {
	await writeJson({
		event: "init",
		conversation_id: conversationId,
		init: {
			cwd: process.cwd(),
			tools: ["call_mcp_tool"],
			permission_mode: "request-review",
			agent: args.agent,
			...(args.model !== undefined ? { model: args.model } : {}),
		},
	});
}

async function emitStep(fields) {
	stepIndex += 1;
	await writeJson({
		event: "step_update",
		step_update: {
			conversation_id: conversationId,
			step_index: stepIndex,
			...fields,
		},
	});
}

async function emitResult(status, response, error) {
	state.turns += 1;
	saveState();
	await writeJson({
		event: "result",
		result: {
			conversation_id: conversationId,
			status,
			response,
			duration_seconds: 0.01,
			num_turns: state.turns,
			usage: USAGE,
			...(error !== undefined ? { error } : {}),
		},
	});
}

async function failTurn(error) {
	if (exiting) return;
	const message = error instanceof Error ? error.message : String(error);
	try {
		await emitResult("ERROR", "", message);
	} catch {
		process.stderr.write(`${message}\n`);
	}
	exitProcess(1);
}

function exitProcess(code) {
	exiting = true;
	process.exit(code);
}

function loadState(id) {
	try {
		const parsed = JSON.parse(readFileSync(statePath(id), "utf8"));
		if (!isRecord(parsed)) return { echoes: [], turns: 0 };
		return {
			echoes: Array.isArray(parsed.echoes) ? parsed.echoes.filter((item) => typeof item === "string") : [],
			turns: typeof parsed.turns === "number" && Number.isFinite(parsed.turns) ? parsed.turns : 0,
		};
	} catch {
		return { echoes: [], turns: 0 };
	}
}

function saveState() {
	const file = statePath(conversationId);
	mkdirSync(dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.tmp`;
	writeFileSync(temporary, JSON.stringify({ echoes: state.echoes, turns: state.turns }));
	renameSync(temporary, file);
}

function statePath(id) {
	return join(process.cwd(), ".fake-agy-state", `${id.replace(/[/\\]/g, "_")}.json`);
}

function appendLog(entry) {
	appendFileSync(join(process.cwd(), ".fake-agy-log.ndjson"), `${JSON.stringify(entry)}\n`);
}

function writeJson(value) {
	return writeStdout(`${JSON.stringify(value)}\n`);
}

function writeStdout(text) {
	return new Promise((resolve, reject) => {
		if (exiting || process.stdout.destroyed) {
			resolve();
			return;
		}
		process.stdout.write(text, (error) => {
			if (error && !exiting) reject(error);
			else resolve();
		});
	});
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
