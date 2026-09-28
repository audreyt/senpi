import { afterEach, describe, expect, it } from "vitest";
import {
	ANTIGRAVITY_SUBSCRIPTION_API_ID,
	ANTIGRAVITY_SUBSCRIPTION_PROVIDER_ID,
	registerAntigravitySubscriptionExtension,
} from "../../src/core/extensions/builtin/antigravity-subscription/index.ts";
import { closeAllSessions, getBinding } from "../../src/core/extensions/builtin/antigravity-subscription/session.ts";
import type { AntigravitySubscriptionSettings } from "../../src/core/extensions/builtin/antigravity-subscription/settings.ts";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import type { ProviderConfigInput } from "../../src/core/provider-composer.ts";

type Handler = (event: Record<string, unknown>, context: Record<string, unknown>) => unknown;

afterEach(() => {
	closeAllSessions();
});

describe("Antigravity subscription extension", () => {
	it("registers the provider beside the Cursor CLI lane with models and subscription OAuth", () => {
		const captured = capture({});
		const ids = builtinExtensions.map((entry) => entry.id);
		const cursorIndex = ids.indexOf("cursor-cli-oauth");

		expect(ids[cursorIndex + 1]).toBe("antigravity-subscription");
		expect(captured.providerId).toBe(ANTIGRAVITY_SUBSCRIPTION_PROVIDER_ID);
		expect(captured.config.name).toBe("Antigravity (agy CLI)");
		expect(captured.config.api).toBe(ANTIGRAVITY_SUBSCRIPTION_API_ID);
		expect(captured.config.baseUrl).toBe(ANTIGRAVITY_SUBSCRIPTION_API_ID);
		expect(captured.config.models).toHaveLength(14);
		expect(captured.config.models?.[0]).toMatchObject({
			id: "gemini-3.8-flash-high",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		expect(captured.config.streamSimple).toBeTypeOf("function");
		expect(captured.config.oauth).toMatchObject({
			name: "Antigravity (agy CLI)",
			isSubscription: true,
		});
	});

	it.each([
		{ settings: {}, eligible: true },
		{ settings: { enabled: true }, eligible: true },
		{ settings: { enabled: false }, eligible: false },
	])("reports fallback eligibility for $settings", ({ settings, eligible }) => {
		const captured = capture(settings);
		expect(captured.config.fallbackEligible?.()).toBe(eligible);
	});

	it("refreshes the catalog without spawning agy until the user opts in", async () => {
		let resolved = 0;
		let config: ProviderConfigInput | undefined;
		const pi = {
			registerProvider: (_id: string, value: ProviderConfigInput) => {
				config = value;
			},
			appendEntry: () => {},
			on: () => {},
		} as unknown as ExtensionAPI;
		registerAntigravitySubscriptionExtension(pi, {
			agentDir: `/tmp/antigravity-extension-test-${process.pid}-${Date.now()}`,
			homeDir: "/tmp/antigravity-extension-home",
			loadSettings: () => ({}),
			resolveExecutable: () => {
				resolved += 1;
				throw new Error("the probe must not run for a lane the user never enabled");
			},
			permissionRulePresent: () => true,
			readAmbientAuthStatus: async () => false,
			readStoredCredential: async () => undefined,
		});
		const refresh = config?.refreshModels;
		if (refresh === undefined) throw new Error("refreshModels missing");
		const models = await refresh({ signal: new AbortController().signal } as Parameters<typeof refresh>[0]);

		expect(models).toHaveLength(14);
		expect(resolved).toBe(0);
	});

	it("fails open when fallback settings cannot be read", () => {
		const captured = capture(() => {
			throw new Error("broken settings");
		});
		expect(captured.config.fallbackEligible?.()).toBe(true);
	});

	it("seeds the newest persisted binding on resumed session start", async () => {
		const captured = capture({});
		const handler = captured.handlers.get("session_start");
		if (handler === undefined) throw new Error("session_start handler missing");
		const older = binding("old", 2);
		const newest = binding("new", 4);
		const branch = [
			{ type: "custom", customType: "antigravity-subscription-binding", data: older },
			{ type: "custom", customType: "other", data: {} },
			{ type: "custom", customType: "antigravity-subscription-binding", data: newest },
		];

		await handler(
			{ type: "session_start", reason: "resume" },
			{
				sessionManager: {
					getSessionId: () => "restored-session",
					getBranch: () => branch,
				},
			},
		);

		expect(getBinding("restored-session")).toEqual({
			conversationId: "new",
			syncedCount: 4,
			prefixDigest: "digest-new",
			modelId: "gemini-3.8-flash-low",
		});
	});
});

function capture(settings: AntigravitySubscriptionSettings | (() => AntigravitySubscriptionSettings)): {
	readonly providerId: string;
	readonly config: ProviderConfigInput;
	readonly handlers: Map<string, Handler>;
} {
	let providerId = "";
	let config: ProviderConfigInput | undefined;
	const handlers = new Map<string, Handler>();
	const pi = {
		registerProvider: (id: string, value: ProviderConfigInput) => {
			providerId = id;
			config = value;
		},
		appendEntry: () => {},
		on: (event: string, handler: Handler) => handlers.set(event, handler),
	} as unknown as ExtensionAPI;
	registerAntigravitySubscriptionExtension(pi, {
		agentDir: "/tmp/antigravity-extension-test",
		homeDir: "/tmp/antigravity-extension-home",
		loadSettings: typeof settings === "function" ? settings : () => settings,
		resolveExecutable: () => "/fake/agy",
		permissionRulePresent: () => true,
		readAmbientAuthStatus: async () => false,
		readStoredCredential: async () => undefined,
	});
	if (config === undefined) throw new Error("provider was not registered");
	return { providerId, config, handlers };
}

function binding(conversationId: string, syncedCount: number): Record<string, unknown> {
	return {
		schemaVersion: 1,
		conversationId,
		syncedCount,
		prefixDigest: `digest-${conversationId}`,
		modelId: "gemini-3.8-flash-low",
	};
}
