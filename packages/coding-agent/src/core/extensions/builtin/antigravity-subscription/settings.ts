import { getAgentDir } from "../../../../config.ts";
import { getFileContentRevision } from "../../../../utils/paths.ts";
import {
	FileSettingsStorage,
	getSettingsPath,
	parseSettingsJson,
	type Settings,
	SettingsManager,
} from "../../../settings-manager.ts";
import { SETTINGS_KEY } from "./constants.ts";

export type AntigravityResumeMode = "auto" | "off";

export interface AntigravitySubscriptionSettings {
	readonly enabled?: boolean;
	readonly executablePath?: string;
	readonly resumeMode?: AntigravityResumeMode;
}

type SettingsWithAntigravitySubscription = Settings & {
	antigravitySubscriptionProvider?: unknown;
};

type Environment = Readonly<Record<string, string | undefined>>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseResumeMode(value: unknown): AntigravityResumeMode | undefined {
	return value === "auto" || value === "off" ? value : undefined;
}

function parseBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function parseEnvironmentBoolean(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	switch (value.toLowerCase()) {
		case "1":
		case "true":
			return true;
		case "0":
		case "false":
			return false;
		default:
			return undefined;
	}
}

function parseNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function parseAntigravitySubscriptionSettings(value: unknown): AntigravitySubscriptionSettings {
	if (!isRecord(value)) return {};
	const enabled = parseBoolean(value.enabled);
	const executablePath = parseNonEmptyString(value.executablePath);
	const resumeMode = parseResumeMode(value.resumeMode);
	return {
		...(enabled !== undefined ? { enabled } : {}),
		...(executablePath !== undefined ? { executablePath } : {}),
		...(resumeMode !== undefined ? { resumeMode } : {}),
	};
}

function parseEnvironmentSettings(environment: Environment): AntigravitySubscriptionSettings {
	const enabled = parseEnvironmentBoolean(environment.SENPI_ANTIGRAVITY_SUBSCRIPTION_ENABLED);
	const executablePath = parseNonEmptyString(environment.SENPI_ANTIGRAVITY_SUBSCRIPTION_EXECUTABLE);
	const resumeMode = parseResumeMode(environment.SENPI_ANTIGRAVITY_SUBSCRIPTION_RESUME);
	return {
		...(enabled !== undefined ? { enabled } : {}),
		...(executablePath !== undefined ? { executablePath } : {}),
		...(resumeMode !== undefined ? { resumeMode } : {}),
	};
}

export function loadAntigravitySubscriptionSettings(
	settingsManager: SettingsManager,
	environment: Environment = process.env,
): AntigravitySubscriptionSettings {
	const global = settingsManager.getGlobalSettings() as SettingsWithAntigravitySubscription;
	const project = settingsManager.getProjectSettings() as SettingsWithAntigravitySubscription;
	return {
		...parseAntigravitySubscriptionSettings(global[SETTINGS_KEY]),
		...parseAntigravitySubscriptionSettings(project[SETTINGS_KEY]),
		...parseEnvironmentSettings(environment),
	};
}

function settingsFingerprint(path: string): string {
	return getFileContentRevision(path) ?? "missing";
}

let cachedManager: { cwd: string; key: string; manager: SettingsManager } | undefined;

export function loadAntigravitySubscriptionSettingsFromDisk(cwd: string): AntigravitySubscriptionSettings {
	const agentDir = getAgentDir();
	const key = `${cwd}|${settingsFingerprint(getSettingsPath(cwd, agentDir, "global"))}|${settingsFingerprint(
		getSettingsPath(cwd, agentDir, "project"),
	)}`;
	let manager = cachedManager?.cwd === cwd && cachedManager.key === key ? cachedManager.manager : undefined;
	if (!manager) {
		manager = SettingsManager.create(cwd, agentDir);
		cachedManager = { cwd, key, manager };
	}
	return loadAntigravitySubscriptionSettings(manager);
}

export type PersistAntigravitySubscriptionEnabledDeps = {
	readonly cwd?: string;
	readonly agentDir?: string;
};

export function persistAntigravitySubscriptionEnabled(
	enabled: boolean,
	deps: PersistAntigravitySubscriptionEnabledDeps = {},
): void {
	const storage = new FileSettingsStorage(deps.cwd ?? process.cwd(), deps.agentDir ?? getAgentDir());
	storage.selectSource("global");
	storage.withLock("global", (current) => {
		let root: Record<string, unknown>;
		try {
			root = current === undefined ? {} : parseSettingsJson(current);
		} catch (error) {
			throw new Error(
				`Cannot persist the Antigravity subscription enabled state: the settings file is unparseable (${error instanceof Error ? error.message : String(error)})`,
			);
		}
		const provider =
			typeof root[SETTINGS_KEY] === "object" && root[SETTINGS_KEY] !== null && !Array.isArray(root[SETTINGS_KEY])
				? { ...(root[SETTINGS_KEY] as Record<string, unknown>) }
				: {};
		return JSON.stringify({ ...root, [SETTINGS_KEY]: { ...provider, enabled } }, null, 2);
	});
}
