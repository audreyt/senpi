import type { AuthContext, OAuthCredential, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { SENTINEL_API_KEY } from "../../src/core/extensions/builtin/antigravity-subscription/constants.ts";
import { createAntigravityOAuthConfig } from "../../src/core/extensions/builtin/antigravity-subscription/oauth-login.ts";

const context: AuthContext = {
	env: async () => undefined,
	fileExists: async () => false,
};
const sentinel: OAuthCredential = {
	type: "oauth",
	access: SENTINEL_API_KEY,
	refresh: SENTINEL_API_KEY,
	expires: Number.MAX_SAFE_INTEGER,
};

describe("Antigravity ambient login", () => {
	it.each([
		{
			name: "stored sentinel",
			enabled: undefined,
			stored: sentinel,
			ambient: true,
			configured: true,
		},
		{
			name: "settings opt-in",
			enabled: true,
			stored: undefined,
			ambient: true,
			configured: true,
		},
		{
			name: "missing opt-in",
			enabled: undefined,
			stored: undefined,
			ambient: true,
			configured: false,
		},
		{
			name: "kill switch",
			enabled: false,
			stored: sentinel,
			ambient: true,
			configured: false,
		},
		{
			name: "logged out agy",
			enabled: true,
			stored: undefined,
			ambient: false,
			configured: false,
		},
	])("$name availability", async ({ enabled, stored, ambient, configured }) => {
		const readAmbientAuthStatus = vi.fn(async () => ambient);
		const oauth = createAntigravityOAuthConfig({
			readSettings: () => (enabled === undefined ? {} : { enabled }),
			readAmbientAuthStatus,
			readStoredCredential: async () => stored,
		});

		const checked = await oauth.check?.({ ctx: context, credential: stored });
		const resolved = await oauth.resolveAmbient?.({ ctx: context });

		expect(checked).toEqual(configured ? { source: "Antigravity CLI", type: "oauth" } : undefined);
		expect(resolved).toEqual(
			configured ? { auth: { apiKey: SENTINEL_API_KEY }, source: "Antigravity CLI" } : undefined,
		);
		if (enabled === false || (enabled === undefined && stored === undefined)) {
			expect(readAmbientAuthStatus).not.toHaveBeenCalled();
		}
	});

	it("installs the bridge permission after yes consent and returns the sentinel", async () => {
		const installPermissionRule = vi.fn(() => ({ installed: true, path: "/home/test/settings.json" }));
		const onPrompt = vi.fn(async () => "yes");
		const oauth = createAntigravityOAuthConfig({
			readSettings: () => ({ enabled: true }),
			readAmbientAuthStatus: async () => true,
			resolveExecutable: () => "/fake/agy",
			permissionRulePath: "/home/test/settings.json",
			hasPermissionRule: () => false,
			installPermissionRule,
		});

		const credential = await oauth.login(callbacks(onPrompt));

		expect(onPrompt).toHaveBeenCalledWith({
			message:
				"Allow senpi's tools inside agy? This adds mcp(senpi-host/*) to ~/.gemini/antigravity-cli/settings.json. [Y/n]",
		});
		expect(installPermissionRule).toHaveBeenCalledWith("/home/test/settings.json");
		expect(credential).toEqual({
			access: SENTINEL_API_KEY,
			refresh: SENTINEL_API_KEY,
			expires: Number.MAX_SAFE_INTEGER,
		});
		expect(await oauth.refreshToken(credential, new AbortController().signal)).toEqual(credential);
		expect(oauth.getApiKey(credential)).toBe(SENTINEL_API_KEY);
	});

	it("cancels without installing when consent is denied", async () => {
		const installPermissionRule = vi.fn();
		const oauth = createAntigravityOAuthConfig({
			readSettings: () => ({ enabled: true }),
			readAmbientAuthStatus: async () => true,
			resolveExecutable: () => "/fake/agy",
			permissionRulePath: "/home/test/settings.json",
			hasPermissionRule: () => false,
			installPermissionRule,
		});

		await expect(oauth.login(callbacks(async () => "no"))).rejects.toThrow("Cancelled: agy permission not granted.");
		expect(installPermissionRule).not.toHaveBeenCalled();
	});

	it("skips consent when the rule already exists", async () => {
		const onPrompt = vi.fn(async () => "no");
		const installPermissionRule = vi.fn();
		const oauth = createAntigravityOAuthConfig({
			readSettings: () => ({ enabled: true }),
			readAmbientAuthStatus: async () => true,
			resolveExecutable: () => "/fake/agy",
			permissionRulePath: "/home/test/settings.json",
			hasPermissionRule: () => true,
			installPermissionRule,
		});

		await expect(oauth.login(callbacks(onPrompt))).resolves.toMatchObject({ access: SENTINEL_API_KEY });
		expect(onPrompt).not.toHaveBeenCalled();
		expect(installPermissionRule).not.toHaveBeenCalled();
	});

	it("requires an ambient agy login before asking for permission", async () => {
		const onPrompt = vi.fn(async () => "yes");
		const oauth = createAntigravityOAuthConfig({
			readSettings: () => ({ enabled: true }),
			readAmbientAuthStatus: async () => false,
			resolveExecutable: () => "/fake/agy",
		});

		await expect(oauth.login(callbacks(onPrompt))).rejects.toThrow(
			"Sign in to the Antigravity CLI first: run `agy` once in a terminal, then run /login antigravity-subscription again.",
		);
		expect(onPrompt).not.toHaveBeenCalled();
	});
});

function callbacks(onPrompt: NonNullable<OAuthLoginCallbacks["onPrompt"]>): OAuthLoginCallbacks {
	return {
		signal: new AbortController().signal,
		onAuth: async () => {},
		onDeviceCode: async () => {},
		onPrompt,
		onSelect: async () => "",
	};
}
