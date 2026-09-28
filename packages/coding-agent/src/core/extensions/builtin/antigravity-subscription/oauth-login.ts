import { homedir } from "node:os";
import type { OAuthCredential, OAuthCredentials } from "@earendil-works/pi-ai";
import type { ExtensionOAuthConfig } from "../../../provider-composer.ts";
import { readAmbientAgyAuthStatus } from "./availability.ts";
import { ANTIGRAVITY_SUBSCRIPTION_NAME, SENTINEL_API_KEY } from "./constants.ts";
import { resolveAgyExecutable } from "./executable.ts";
import { agySettingsPath, hasBridgePermissionRule, installBridgePermissionRule } from "./permission-rule.ts";
import { type AntigravitySubscriptionSettings, loadAntigravitySubscriptionSettingsFromDisk } from "./settings.ts";

const AUTH_CHECK = { source: "Antigravity CLI", type: "oauth" } as const;
const CONSENT_PROMPT =
	"Allow senpi's tools inside agy? This adds mcp(senpi-host/*) to ~/.gemini/antigravity-cli/settings.json. [Y/n]";
const SIGN_IN_GUIDANCE =
	"Sign in to the Antigravity CLI first: run `agy` once in a terminal, then run /login antigravity-subscription again.";

export type AntigravityOAuthDeps = {
	readonly readSettings: () => AntigravitySubscriptionSettings;
	readonly readAmbientAuthStatus: (signal?: AbortSignal) => Promise<boolean>;
	readonly resolveExecutable: (settings: AntigravitySubscriptionSettings) => string;
	readonly permissionRulePath: string;
	readonly hasPermissionRule: (path: string) => boolean;
	readonly installPermissionRule: (path: string) => { installed: boolean; path: string };
	readonly readStoredCredential: () => Promise<OAuthCredential | undefined>;
};

const defaultDeps: AntigravityOAuthDeps = {
	readSettings: () => loadAntigravitySubscriptionSettingsFromDisk(process.cwd()),
	readAmbientAuthStatus: readAmbientAgyAuthStatus,
	resolveExecutable: (settings) => resolveAgyExecutable(settings),
	permissionRulePath: agySettingsPath(homedir()),
	hasPermissionRule: hasBridgePermissionRule,
	installPermissionRule: installBridgePermissionRule,
	readStoredCredential: async () => undefined,
};

export function createAntigravityOAuthConfig(overrides: Partial<AntigravityOAuthDeps> = {}): ExtensionOAuthConfig {
	const deps = { ...defaultDeps, ...overrides };
	const configuredFor = async (stored: OAuthCredential | undefined, signal?: AbortSignal): Promise<boolean> => {
		const settings = deps.readSettings();
		if (settings.enabled === false) return false;
		const optedIn = stored?.access === SENTINEL_API_KEY || settings.enabled === true;
		if (!optedIn) return false;
		return deps.readAmbientAuthStatus(signal);
	};

	return {
		name: ANTIGRAVITY_SUBSCRIPTION_NAME,
		isSubscription: true,

		async check({ credential }) {
			const stored = credential ?? (await deps.readStoredCredential());
			return (await configuredFor(stored)) ? AUTH_CHECK : undefined;
		},

		async resolveAmbient({ signal }) {
			if (!(await configuredFor(await deps.readStoredCredential(), signal))) return undefined;
			return {
				auth: { apiKey: SENTINEL_API_KEY },
				source: AUTH_CHECK.source,
			};
		},

		async login(callbacks) {
			const settings = deps.readSettings();
			deps.resolveExecutable(settings);
			if (!(await deps.readAmbientAuthStatus(callbacks.signal))) throw new Error(SIGN_IN_GUIDANCE);
			if (!deps.hasPermissionRule(deps.permissionRulePath)) {
				const answer = callbacks.onPrompt
					? (await callbacks.onPrompt({ message: CONSENT_PROMPT })).trim().toLowerCase()
					: "";
				if (answer !== "" && answer !== "y" && answer !== "yes") {
					throw new Error("Cancelled: agy permission not granted.");
				}
				deps.installPermissionRule(deps.permissionRulePath);
			}
			return sentinelCredential();
		},

		async refreshToken(credentials) {
			return credentials;
		},

		getApiKey() {
			return SENTINEL_API_KEY;
		},
	};
}

function sentinelCredential(): OAuthCredentials {
	return {
		access: SENTINEL_API_KEY,
		refresh: SENTINEL_API_KEY,
		expires: Number.MAX_SAFE_INTEGER,
	};
}
