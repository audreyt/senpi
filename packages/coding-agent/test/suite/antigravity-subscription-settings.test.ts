import { describe, expect, it } from "vitest";
import { SETTINGS_KEY } from "../../src/core/extensions/builtin/antigravity-subscription/constants.ts";
import { agyChildEnvironment } from "../../src/core/extensions/builtin/antigravity-subscription/environment.ts";
import {
	type AgyExecutableDeps,
	AgyNotInstalledError,
	resolveAgyExecutable,
} from "../../src/core/extensions/builtin/antigravity-subscription/executable.ts";
import {
	loadAntigravitySubscriptionSettings,
	parseAntigravitySubscriptionSettings,
} from "../../src/core/extensions/builtin/antigravity-subscription/settings.ts";
import { InMemorySettingsStorage, SettingsManager } from "../../src/core/settings-manager.ts";

function settingsManager(global: unknown = {}, project: unknown = {}): SettingsManager {
	const storage = new InMemorySettingsStorage();
	storage.withLock("global", () => JSON.stringify({ [SETTINGS_KEY]: global }));
	storage.withLock("project", () => JSON.stringify({ [SETTINGS_KEY]: project }));
	return SettingsManager.fromStorage(storage);
}

function executableDeps(
	options: {
		env?: Record<string, string | undefined>;
		existing?: readonly string[];
		executable?: readonly string[];
		home?: string;
	} = {},
): AgyExecutableDeps {
	const existing = new Set(options.existing ?? []);
	const executable = new Set(options.executable ?? options.existing ?? []);
	return {
		env: options.env ?? {},
		homedir: options.home ?? "/home/test",
		pathExists: (path) => existing.has(path),
		isExecutable: (path) => executable.has(path),
	};
}

describe("antigravity subscription settings", () => {
	it("parses valid values and silently drops invalid fields", () => {
		expect(
			parseAntigravitySubscriptionSettings({
				enabled: true,
				executablePath: "/opt/agy",
				resumeMode: "off",
				extra: true,
			}),
		).toEqual({ enabled: true, executablePath: "/opt/agy", resumeMode: "off" });
		expect(
			parseAntigravitySubscriptionSettings({
				enabled: "yes",
				executablePath: "",
				resumeMode: "never",
			}),
		).toEqual({});
		expect(parseAntigravitySubscriptionSettings(null)).toEqual({});
	});

	it("merges global, project, and environment settings in precedence order", () => {
		const manager = settingsManager(
			{ enabled: false, executablePath: "/global/agy", resumeMode: "auto" },
			{ enabled: false, executablePath: "/project/agy" },
		);
		expect(
			loadAntigravitySubscriptionSettings(manager, {
				SENPI_ANTIGRAVITY_SUBSCRIPTION_ENABLED: "TrUe",
				SENPI_ANTIGRAVITY_SUBSCRIPTION_EXECUTABLE: "/env/agy",
				SENPI_ANTIGRAVITY_SUBSCRIPTION_RESUME: "off",
			}),
		).toEqual({ enabled: true, executablePath: "/env/agy", resumeMode: "off" });
		expect(loadAntigravitySubscriptionSettings(manager, {})).toEqual({
			enabled: false,
			executablePath: "/project/agy",
			resumeMode: "auto",
		});
	});

	it("resolves executable overrides before PATH and home fallback", () => {
		const deps = executableDeps({
			env: { SENPI_ANTIGRAVITY_SUBSCRIPTION_EXECUTABLE: "/env/agy", PATH: "/bin:/usr/bin" },
			existing: ["/env/agy", "/setting/agy", "/bin/agy", "/home/test/.local/bin/agy"],
		});
		expect(resolveAgyExecutable({ executablePath: "/setting/agy" }, deps)).toBe("/env/agy");
		expect(
			resolveAgyExecutable(
				{ executablePath: "/setting/agy" },
				executableDeps({
					env: { PATH: "/bin:/usr/bin" },
					existing: ["/setting/agy", "/bin/agy"],
				}),
			),
		).toBe("/setting/agy");
		expect(
			resolveAgyExecutable(
				{},
				executableDeps({
					env: { PATH: "/bin:/usr/bin" },
					existing: ["/bin/agy", "/home/test/.local/bin/agy"],
				}),
			),
		).toBe("/bin/agy");
		expect(
			resolveAgyExecutable({}, executableDeps({ env: { PATH: "" }, existing: ["/home/test/.local/bin/agy"] })),
		).toBe("/home/test/.local/bin/agy");
	});

	it("rejects missing or non-executable candidates with installation guidance", () => {
		const deps = executableDeps({
			env: { SENPI_ANTIGRAVITY_SUBSCRIPTION_EXECUTABLE: "/bad/agy", PATH: "/bin" },
			existing: ["/bad/agy", "/bin/agy"],
			executable: [],
		});
		expect(() => resolveAgyExecutable({}, deps)).toThrow(AgyNotInstalledError);
		expect(() => resolveAgyExecutable({}, deps)).toThrow(/https:\/\/antigravity\.google\/docs\/cli\/installation/);
		expect(() => resolveAgyExecutable({}, deps)).toThrow("/bad/agy");
	});

	it("copies only allowlisted environment variables", () => {
		expect(
			agyChildEnvironment({
				HOME: "/home/test",
				PATH: "/bin",
				SENPI_FOO: "secret",
				OPENAI_API_KEY: "secret",
				UNRELATED: "value",
				TERM: undefined,
			}),
		).toEqual({ HOME: "/home/test", PATH: "/bin" });
	});
});
