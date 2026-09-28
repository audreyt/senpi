import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { getAgentDir } from "../../../../config.ts";
import { AuthStorage } from "../../../auth-storage.ts";
import type { ProviderConfigInput } from "../../../provider-composer.ts";
import type { ExtensionAPI } from "../../types.ts";
import { lastProbedModels, probeAgyModels, readAmbientAgyAuthStatus } from "./availability.ts";
import { stopBridgeServer } from "./bridge-server.ts";
import {
	ANTIGRAVITY_SUBSCRIPTION_API_ID,
	ANTIGRAVITY_SUBSCRIPTION_NAME,
	ANTIGRAVITY_SUBSCRIPTION_PROVIDER_ID,
} from "./constants.ts";
import { agyChildEnvironment } from "./environment.ts";
import { resolveAgyExecutable } from "./executable.ts";
import {
	parseAgyModels,
	readCachedAgyModels,
	STATIC_AGY_MODELS,
	toProviderModels,
	writeCachedAgyModels,
} from "./models.ts";
import { createAntigravityOAuthConfig } from "./oauth-login.ts";
import { agySettingsPath, hasBridgePermissionRule, installBridgePermissionRule } from "./permission-rule.ts";
import { closeAllSessions, closeSession, type SeedBindingInput, seedBinding } from "./session.ts";
import { type AntigravitySubscriptionSettings, loadAntigravitySubscriptionSettingsFromDisk } from "./settings.ts";
import { createAntigravityStream } from "./stream.ts";

export {
	ANTIGRAVITY_SUBSCRIPTION_API_ID,
	ANTIGRAVITY_SUBSCRIPTION_NAME,
	ANTIGRAVITY_SUBSCRIPTION_PROVIDER_ID,
} from "./constants.ts";

const BINDING_ENTRY_TYPE = "antigravity-subscription-binding";

export type AntigravitySubscriptionExtensionDeps = {
	readonly cwd?: string;
	readonly agentDir?: string;
	readonly homeDir?: string;
	readonly loadSettings?: () => AntigravitySubscriptionSettings;
	readonly resolveExecutable?: (settings: AntigravitySubscriptionSettings) => string;
	readonly permissionRulePresent?: () => boolean;
	readonly readAmbientAuthStatus?: (signal?: AbortSignal) => Promise<boolean>;
	readonly readStoredCredential?: () => Promise<OAuthCredential | undefined>;
	readonly now?: () => number;
};

type StoredBindingEntry = SeedBindingInput & {
	readonly schemaVersion: 1;
};

export function registerAntigravitySubscriptionExtension(
	pi: ExtensionAPI,
	deps: AntigravitySubscriptionExtensionDeps = {},
): void {
	const cwd = deps.cwd ?? process.cwd();
	const agentDir = deps.agentDir ?? getAgentDir();
	const homeDir = deps.homeDir ?? homedir();
	const loadSettings = deps.loadSettings ?? (() => loadAntigravitySubscriptionSettingsFromDisk(cwd));
	const resolveExecutable =
		deps.resolveExecutable ?? ((settings: AntigravitySubscriptionSettings) => resolveAgyExecutable(settings));
	const permissionRulePath = agySettingsPath(homeDir);
	const permissionRulePresent = deps.permissionRulePresent ?? (() => hasBridgePermissionRule(permissionRulePath));
	const readStoredCredential =
		deps.readStoredCredential ??
		(async () => {
			const credential = await AuthStorage.create().read(ANTIGRAVITY_SUBSCRIPTION_PROVIDER_ID);
			return credential?.type === "oauth" ? credential : undefined;
		});

	// Probing spawns agy; a user who never opted in must not pay for it on every startup.
	const optedIn = async (): Promise<boolean> => {
		try {
			const settings = loadSettings();
			if (settings.enabled === false) return false;
			if (settings.enabled === true) return true;
			return (await readStoredCredential()) !== undefined;
		} catch {
			return false;
		}
	};

	const streamSimple = createAntigravityStream({
		resolveExecutable,
		loadSettings,
		agentDir,
		permissionRulePresent,
		homeDir,
		onBinding: (_key, binding) => {
			pi.appendEntry(BINDING_ENTRY_TYPE, {
				schemaVersion: 1,
				...binding,
			} satisfies StoredBindingEntry);
		},
	});
	const config: ProviderConfigInput = {
		name: ANTIGRAVITY_SUBSCRIPTION_NAME,
		baseUrl: ANTIGRAVITY_SUBSCRIPTION_API_ID,
		api: ANTIGRAVITY_SUBSCRIPTION_API_ID,
		models: toProviderModels(STATIC_AGY_MODELS),
		streamSimple,
		refreshModels: async (context) => {
			const cachePath = join(agentDir, "antigravity-subscription", "models.json");
			const now = (deps.now ?? Date.now)();
			const cached = await readCachedAgyModels(cachePath, now);
			if (cached !== undefined) return toProviderModels(cached);
			if (context.signal.aborted || !(await optedIn())) return toProviderModels(STATIC_AGY_MODELS);

			const remembered = lastProbedModels();
			if (remembered !== undefined && remembered.length > 0) {
				await cacheModels(cachePath, remembered, now);
				return toProviderModels(remembered);
			}
			try {
				const executable = resolveExecutable(loadSettings());
				const result = await probeAgyModels({
					executable,
					env: agyChildEnvironment(),
				});
				if (!result.ok || context.signal.aborted) return toProviderModels(STATIC_AGY_MODELS);
				const entries = parseAgyModels(result.stdout);
				if (entries.length === 0) return toProviderModels(STATIC_AGY_MODELS);
				await cacheModels(cachePath, entries, now);
				return toProviderModels(entries);
			} catch {
				return toProviderModels(STATIC_AGY_MODELS);
			}
		},
		fallbackEligible: () => {
			try {
				return loadSettings().enabled !== false;
			} catch {
				return true;
			}
		},
		oauth: createAntigravityOAuthConfig({
			readSettings: loadSettings,
			readAmbientAuthStatus: deps.readAmbientAuthStatus ?? readAmbientAgyAuthStatus,
			resolveExecutable,
			permissionRulePath,
			hasPermissionRule: hasBridgePermissionRule,
			installPermissionRule: installBridgePermissionRule,
			readStoredCredential,
		}),
	};
	pi.registerProvider(ANTIGRAVITY_SUBSCRIPTION_PROVIDER_ID, config);

	pi.on("session_start", (event, ctx) => {
		if (event.reason === "new" || event.reason === "fork" || event.reason === "reload") return;
		const binding = newestBinding(ctx.sessionManager.getBranch());
		if (binding !== undefined) seedBinding(ctx.sessionManager.getSessionId(), binding);
	});
	pi.on("model_select", (event, ctx) => {
		if (event.model.provider === ANTIGRAVITY_SUBSCRIPTION_PROVIDER_ID) return;
		closeSession(ctx.sessionManager.getSessionId(), "model_selected", { keepConversation: true });
	});
	pi.on("session_shutdown", async () => {
		closeAllSessions();
		await stopBridgeServer();
	});
}

async function cacheModels(path: string, entries: Parameters<typeof toProviderModels>[0], now: number): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeCachedAgyModels(path, entries, now);
}

function newestBinding(branch: readonly unknown[]): StoredBindingEntry | undefined {
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== BINDING_ENTRY_TYPE) continue;
		return parseBinding(entry.data);
	}
	return undefined;
}

function parseBinding(value: unknown): StoredBindingEntry | undefined {
	if (!isRecord(value) || value.schemaVersion !== 1) return undefined;
	if (
		typeof value.conversationId !== "string" ||
		typeof value.syncedCount !== "number" ||
		!Number.isInteger(value.syncedCount) ||
		value.syncedCount < 0 ||
		typeof value.prefixDigest !== "string" ||
		typeof value.modelId !== "string"
	) {
		return undefined;
	}
	return {
		schemaVersion: 1,
		conversationId: value.conversationId,
		syncedCount: value.syncedCount,
		prefixDigest: value.prefixDigest,
		modelId: value.modelId,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default function antigravitySubscriptionExtension(pi: ExtensionAPI): void {
	registerAntigravitySubscriptionExtension(pi);
}
