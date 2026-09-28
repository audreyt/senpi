import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PERMISSION_RULE } from "./constants.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function agySettingsPath(home: string): string {
	return join(home, ".gemini", "antigravity-cli", "settings.json");
}

export function hasBridgePermissionRule(path: string): boolean {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isRecord(parsed) || !isRecord(parsed.permissions) || !Array.isArray(parsed.permissions.allow)) return false;
		return parsed.permissions.allow.includes(PERMISSION_RULE) || parsed.permissions.allow.includes("mcp(*)");
	} catch {
		return false;
	}
}

export function installBridgePermissionRule(path: string): { installed: boolean; path: string } {
	let content: string;
	try {
		content = readFileSync(path, "utf8");
	} catch (error) {
		if (!isRecord(error) || error.code !== "ENOENT") throw error;
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		writeFileSync(path, `${JSON.stringify({ permissions: { allow: [PERMISSION_RULE] } }, null, 2)}\n`, {
			mode: 0o600,
		});
		return { installed: true, path };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		throw new Error(`Cannot install Antigravity permission rule in ${path}: malformed JSON; file was not modified`);
	}
	if (!isRecord(parsed)) {
		throw new Error(
			`Cannot install Antigravity permission rule in ${path}: settings must be a JSON object; file was not modified`,
		);
	}

	const settings = parsed;
	const permissions = isRecord(settings.permissions) ? settings.permissions : {};
	if (permissions.allow !== undefined && !Array.isArray(permissions.allow)) {
		throw new Error(
			`Cannot install Antigravity permission rule in ${path}: permissions.allow is not an array; file was not modified`,
		);
	}
	const allow: unknown[] = permissions.allow ?? [];
	if (allow.includes(PERMISSION_RULE) || allow.includes("mcp(*)")) return { installed: false, path };

	const mode = statSync(path).mode & 0o777;
	settings.permissions = { ...permissions, allow: [...allow, PERMISSION_RULE] };
	const temporaryPath = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
	writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { mode });
	renameSync(temporaryPath, path);
	return { installed: true, path };
}
