import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_NAME, BRIDGE_SERVER_NAME } from "./constants.ts";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

const AGENT_DESCRIPTION = `Senpi host agent: every tool runs on the user's machine through the ${BRIDGE_SERVER_NAME} MCP server.`;

export type PrepareSessionWorkspaceInput = {
	readonly rootDir: string;
	readonly sessionKey: string;
	readonly systemPrompt: string;
	readonly projectCwd: string;
	readonly bridgeUrl: string;
	readonly token: string;
};

export type PreparedSessionWorkspace = {
	readonly dir: string;
	readonly fingerprint: string;
};

export function hostPreamble(projectCwd: string): string {
	const onlyTools = `Your only tools are on the MCP server named "${BRIDGE_SERVER_NAME}"`;
	const onTheHost = "and they execute on the user's machine in that directory.";
	const slowResult = "A tool result can take a long time because senpi may ask the user for approval,";
	const waitForIt = "so wait for it and never retry a call just because it is slow.";
	return [
		"You are the model inside the senpi coding agent.",
		`The user's project directory is ${projectCwd}.`,
		`${onlyTools} ${onTheHost}`,
		"Call them through MCP with exact argument names from their schemas.",
		`${slowResult} ${waitForIt}`,
		"Your own working directory is a private scratch space, never the project.",
	].join(" ");
}

export function sessionWorkspaceRoot(agentDir: string): string {
	return join(agentDir, "antigravity-subscription", "workspaces");
}

export function prepareSessionWorkspace(input: PrepareSessionWorkspaceInput): PreparedSessionWorkspace {
	const dir = join(input.rootDir, sessionDirectoryName(input.sessionKey));
	const agentsDir = join(dir, ".agents");
	const agentDir = join(agentsDir, "agents", AGENT_NAME);
	ensurePrivateDir(dir);
	ensurePrivateDir(agentsDir);
	ensurePrivateDir(join(agentsDir, "agents"));
	ensurePrivateDir(agentDir);

	const agentMd = renderAgentMarkdown(input.projectCwd, input.systemPrompt);
	const mcpJson = renderMcpConfig(input.bridgeUrl, input.token);
	writeIfBytesChanged(join(agentDir, "agent.md"), agentMd);
	writeIfBytesChanged(join(agentsDir, "mcp_config.json"), mcpJson);
	return { dir, fingerprint: continuityFingerprint(agentMd, mcpJson, input.token) };
}

export function removeSessionWorkspace(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
}

function sessionDirectoryName(sessionKey: string): string {
	return createHash("sha256").update(sessionKey, "utf8").digest("hex").slice(0, 16);
}

function renderAgentMarkdown(projectCwd: string, systemPrompt: string): string {
	const frontmatter = [
		"---",
		`name: ${AGENT_NAME}`,
		`description: "${AGENT_DESCRIPTION}"`,
		"tools: []",
		"mainAgent: true",
		"subagent: false",
		'commandExecutionPolicy: "off"',
		"---",
	].join("\n");
	return `${frontmatter}\n${hostPreamble(projectCwd)}\n\n${systemPrompt}`;
}

function renderMcpConfig(bridgeUrl: string, token: string): string {
	return `${JSON.stringify({
		mcpServers: {
			[BRIDGE_SERVER_NAME]: {
				serverUrl: bridgeUrl,
				headers: {
					Authorization: `Bearer ${token}`,
				},
			},
		},
	})}\n`;
}

/** Redact the JSON-encoded bearer value so token rotation does not change continuity. */
function continuityFingerprint(agentMd: string, mcpJson: string, token: string): string {
	const bearer = JSON.stringify(`Bearer ${token}`);
	const redacted = mcpJson.split(bearer).join(JSON.stringify("Bearer <token>"));
	return createHash("sha256").update(agentMd, "utf8").update("\n", "utf8").update(redacted, "utf8").digest("hex");
}

function ensurePrivateDir(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: DIRECTORY_MODE });
	chmodSync(dir, DIRECTORY_MODE);
}

function writeIfBytesChanged(filePath: string, content: string): void {
	const next = Buffer.from(content, "utf8");
	if (existsSync(filePath) && readFileSync(filePath).equals(next)) {
		chmodSync(filePath, FILE_MODE);
		return;
	}
	writeFileSync(filePath, next, { mode: FILE_MODE });
	chmodSync(filePath, FILE_MODE);
}
