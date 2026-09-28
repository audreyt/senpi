import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PERMISSION_RULE } from "../../src/core/extensions/builtin/antigravity-subscription/constants.ts";
import {
	agySettingsPath,
	hasBridgePermissionRule,
	installBridgePermissionRule,
} from "../../src/core/extensions/builtin/antigravity-subscription/permission-rule.ts";

const temporaryDirectories: string[] = [];

function makeSettingsPath(): string {
	const home = mkdtempSync(join(tmpdir(), "agy-permission-rule-"));
	temporaryDirectories.push(home);
	const path = agySettingsPath(home);
	mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
	return path;
}

afterEach(() => {
	for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Antigravity permission rule", () => {
	it("creates missing settings with private permissions", () => {
		const path = makeSettingsPath();
		expect(installBridgePermissionRule(path)).toEqual({ installed: true, path });
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ permissions: { allow: [PERMISSION_RULE] } });
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("merges the rule while preserving settings and rule order", () => {
		const path = makeSettingsPath();
		const original = {
			colorScheme: "dark",
			model: "gemini",
			permissions: { allow: ["shell(*)", "mcp(other/*)"], deny: ["shell(rm)"] },
			trustedWorkspaces: ["/project"],
		};
		writeFileSync(path, JSON.stringify(original), { mode: 0o640 });

		expect(installBridgePermissionRule(path)).toEqual({ installed: true, path });
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			...original,
			permissions: { ...original.permissions, allow: [...original.permissions.allow, PERMISSION_RULE] },
		});
		expect(statSync(path).mode & 0o777).toBe(0o640);
		expect(readFileSync(path, "utf8")).toBe(`${JSON.stringify(JSON.parse(readFileSync(path, "utf8")), null, 2)}\n`);
	});

	it("leaves an already-installed rule byte-identical", () => {
		const path = makeSettingsPath();
		const bytes = '{"permissions":{"allow":["mcp(senpi-host/*)"]}}\n';
		writeFileSync(path, bytes);
		const before = statSync(path);

		expect(installBridgePermissionRule(path)).toEqual({ installed: false, path });
		expect(readFileSync(path, "utf8")).toBe(bytes);
		expect(statSync(path).mtimeMs).toBe(before.mtimeMs);
	});

	it("recognizes the broad mcp wildcard as already present", () => {
		const path = makeSettingsPath();
		writeFileSync(path, JSON.stringify({ permissions: { allow: ["mcp(*)"] } }));
		expect(hasBridgePermissionRule(path)).toBe(true);
		expect(installBridgePermissionRule(path)).toEqual({ installed: false, path });
	});

	it("returns false when settings are missing or malformed", () => {
		const path = makeSettingsPath();
		expect(hasBridgePermissionRule(path)).toBe(false);
		writeFileSync(path, "{");
		expect(hasBridgePermissionRule(path)).toBe(false);
	});

	it("refuses malformed and non-object JSON without changing bytes", () => {
		const path = makeSettingsPath();
		for (const bytes of ["{", "[]"]) {
			writeFileSync(path, bytes);
			expect(() => installBridgePermissionRule(path)).toThrow(
				expect.objectContaining({ message: expect.stringContaining(path) }),
			);
			expect(readFileSync(path, "utf8")).toBe(bytes);
		}
	});

	it("refuses non-array permissions.allow without changing bytes", () => {
		const path = makeSettingsPath();
		const bytes = '{"permissions":{"allow":"mcp(*)"}}';
		writeFileSync(path, bytes);
		expect(() => installBridgePermissionRule(path)).toThrow(
			expect.objectContaining({ message: expect.stringContaining(path) }),
		);
		expect(readFileSync(path, "utf8")).toBe(bytes);
	});
});
