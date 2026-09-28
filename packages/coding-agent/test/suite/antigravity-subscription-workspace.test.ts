import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	hostPreamble,
	type PrepareSessionWorkspaceInput,
	prepareSessionWorkspace,
	removeSessionWorkspace,
	sessionWorkspaceRoot,
} from "../../src/core/extensions/builtin/antigravity-subscription/workspace.ts";

const roots: string[] = [];
let previousUmask = 0o022;

const baseInput = {
	sessionKey: "session-1",
	systemPrompt: "Be precise.",
	projectCwd: "/proj",
	bridgeUrl: "http://127.0.0.1:9/mcp",
	token: "wk-token-1",
} as const;

beforeEach(() => {
	previousUmask = process.umask(0o222);
});

afterEach(() => {
	process.umask(previousUmask);
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "agy-workspace-"));
	chmodSync(root, 0o700);
	roots.push(root);
	return root;
}

function prepare(
	rootDir: string,
	overrides: Partial<Omit<PrepareSessionWorkspaceInput, "rootDir">> = {},
): ReturnType<typeof prepareSessionWorkspace> {
	return prepareSessionWorkspace({ rootDir, ...baseInput, ...overrides });
}

function agentPath(dir: string): string {
	return join(dir, ".agents", "agents", "senpi-host", "agent.md");
}

function mcpPath(dir: string): string {
	return join(dir, ".agents", "mcp_config.json");
}

function mode(filePath: string): number {
	return statSync(filePath).mode & 0o777;
}

function freezeMtime(filePath: string): number {
	const past = new Date("2020-01-01T00:00:00.000Z");
	utimesSync(filePath, past, past);
	return statSync(filePath).mtimeMs;
}

describe("prepareSessionWorkspace", () => {
	it("creates a private session dir and the agy workspace files", () => {
		const root = tempRoot();
		const prepared = prepare(root);
		const expectedName = createHash("sha256").update(baseInput.sessionKey, "utf8").digest("hex").slice(0, 16);

		expect(prepared.dir).toBe(join(root, expectedName));
		expect(mode(prepared.dir)).toBe(0o700);
		expect(mode(agentPath(prepared.dir))).toBe(0o600);
		expect(mode(mcpPath(prepared.dir))).toBe(0o600);

		const agentMd = readFileSync(agentPath(prepared.dir), "utf8");
		expect(agentMd.split("\n").slice(0, 8)).toEqual([
			"---",
			"name: senpi-host",
			'description: "Senpi host agent: every tool runs on the user\'s machine through the senpi-host MCP server."',
			"tools: []",
			"mainAgent: true",
			"subagent: false",
			'commandExecutionPolicy: "off"',
			"---",
		]);
		const bodyStart = agentMd.indexOf("\n---\n");
		expect(agentMd.slice(bodyStart + "\n---\n".length)).toBe(
			`${hostPreamble(baseInput.projectCwd)}\n\n${baseInput.systemPrompt}`,
		);
		expect(JSON.parse(readFileSync(mcpPath(prepared.dir), "utf8"))).toEqual({
			mcpServers: {
				"senpi-host": {
					serverUrl: baseInput.bridgeUrl,
					headers: { Authorization: `Bearer ${baseInput.token}` },
				},
			},
		});
	});

	it("hashes agent.md plus the MCP config with the token replaced by <token>", () => {
		const root = tempRoot();
		const prepared = prepare(root);
		const agentMd = readFileSync(agentPath(prepared.dir), "utf8");
		const mcpJson = readFileSync(mcpPath(prepared.dir), "utf8");
		const redacted = mcpJson.split(baseInput.token).join("<token>");
		const expected = createHash("sha256").update(`${agentMd}\n${redacted}`, "utf8").digest("hex");

		expect(prepared.fingerprint).toBe(expected);
		expect(prepared.fingerprint).toHaveLength(64);
	});

	it("keeps the fingerprint and agent.md when only the token changes", () => {
		const root = tempRoot();
		const first = prepare(root, { token: "wk-token-1" });
		const agentBefore = readFileSync(agentPath(first.dir));
		const agentMtime = freezeMtime(agentPath(first.dir));
		const mcpMtime = freezeMtime(mcpPath(first.dir));

		const second = prepare(root, { token: "wk-token-2" });

		expect(second.dir).toBe(first.dir);
		expect(second.fingerprint).toBe(first.fingerprint);
		expect(readFileSync(agentPath(first.dir)).equals(agentBefore)).toBe(true);
		expect(statSync(agentPath(first.dir)).mtimeMs).toBe(agentMtime);
		expect(statSync(mcpPath(first.dir)).mtimeMs).not.toBe(mcpMtime);
		expect(mode(mcpPath(first.dir))).toBe(0o600);
		expect(JSON.parse(readFileSync(mcpPath(first.dir), "utf8"))).toMatchObject({
			mcpServers: { "senpi-host": { headers: { Authorization: "Bearer wk-token-2" } } },
		});
	});

	it("keeps the fingerprint when a JSON-escaped token is rotated", () => {
		const root = tempRoot();
		const first = prepare(root, { token: 'a"b\\c' });
		const second = prepare(root, { token: 'z"q' });

		expect(second.fingerprint).toBe(first.fingerprint);
		expect(JSON.parse(readFileSync(mcpPath(first.dir), "utf8"))).toMatchObject({
			mcpServers: { "senpi-host": { headers: { Authorization: 'Bearer z"q' } } },
		});
	});

	it("changes the fingerprint when the system prompt changes and leaves mcp_config untouched", () => {
		const root = tempRoot();
		const first = prepare(root, { systemPrompt: "alpha" });
		const agentMtime = freezeMtime(agentPath(first.dir));
		const mcpMtime = freezeMtime(mcpPath(first.dir));

		const second = prepare(root, { systemPrompt: "beta" });

		expect(second.fingerprint).not.toBe(first.fingerprint);
		expect(readFileSync(agentPath(first.dir), "utf8")).toContain("beta");
		expect(statSync(agentPath(first.dir)).mtimeMs).not.toBe(agentMtime);
		expect(statSync(mcpPath(first.dir)).mtimeMs).toBe(mcpMtime);
	});

	it("leaves file mtimes alone when the workspace content is unchanged", () => {
		const root = tempRoot();
		const first = prepare(root);
		const agentMtime = freezeMtime(agentPath(first.dir));
		const mcpMtime = freezeMtime(mcpPath(first.dir));

		const second = prepare(root);

		expect(second.fingerprint).toBe(first.fingerprint);
		expect(statSync(agentPath(first.dir)).mtimeMs).toBe(agentMtime);
		expect(statSync(mcpPath(first.dir)).mtimeMs).toBe(mcpMtime);
	});

	it("changes the fingerprint when the bridge URL changes", () => {
		const root = tempRoot();
		const first = prepare(root, { bridgeUrl: "http://127.0.0.1:1/mcp" });
		const second = prepare(root, { bridgeUrl: "http://127.0.0.1:2/mcp" });

		expect(second.fingerprint).not.toBe(first.fingerprint);
	});
});

describe("removeSessionWorkspace", () => {
	it("removes the directory and ignores a path that is already gone", () => {
		const root = tempRoot();
		const prepared = prepare(root);

		removeSessionWorkspace(prepared.dir);
		expect(existsSync(prepared.dir)).toBe(false);
		expect(() => removeSessionWorkspace(prepared.dir)).not.toThrow();
	});
});

describe("sessionWorkspaceRoot", () => {
	it("joins the per-agent workspaces directory", () => {
		expect(sessionWorkspaceRoot(join("/tmp", "agent"))).toBe(
			join("/tmp", "agent", "antigravity-subscription", "workspaces"),
		);
	});
});

describe("hostPreamble", () => {
	it("names the project directory and the senpi-host server in four to six sentences", () => {
		const text = hostPreamble("/proj");
		const sentences = text.split(/(?<=\.)\s+/);

		expect(text).toContain("/proj");
		expect(text).toContain("senpi-host");
		expect(sentences.length).toBeGreaterThanOrEqual(4);
		expect(sentences.length).toBeLessThanOrEqual(6);
	});
});
