import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	parseAgyModels,
	readCachedAgyModels,
	STATIC_AGY_MODELS,
	toProviderModels,
	writeCachedAgyModels,
} from "../../src/core/extensions/builtin/antigravity-subscription/models.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Antigravity models", () => {
	it("parses ANSI-decorated model listings and ignores headers", () => {
		expect(
			parseAgyModels(
				"\u001B[32mFetching available models...\u001B[0m\n" +
					"gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n" +
					"claude-sonnet-4-6  Claude Sonnet 4.6 (Thinking)\n",
			),
		).toEqual([
			{ id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
			{ id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)" },
		]);
	});

	it("provides fourteen static models", () => {
		expect(STATIC_AGY_MODELS).toHaveLength(14);
	});

	it("maps models to the provider configuration shape", () => {
		expect(
			toProviderModels([
				{ id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" },
				{ id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)" },
			]),
		).toEqual([
			{
				id: "gemini-3.8-flash-low",
				name: "Gemini 3.8 Flash (Low) via Antigravity",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_000_000,
				maxTokens: 64_000,
			},
			{
				id: "claude-sonnet-4-6",
				name: "Claude Sonnet 4.6 (Thinking) via Antigravity",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 64_000,
			},
		]);
	});

	it("round-trips fresh cache entries and rejects stale or corrupt files", async () => {
		const directory = await mkdtemp(join(tmpdir(), "agy-models-"));
		temporaryDirectories.push(directory);
		const path = join(directory, "models.json");
		const entries = [{ id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" }];
		await writeCachedAgyModels(path, entries, 1_000);
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ fetchedAt: 1_000, entries });
		expect(await readCachedAgyModels(path, 1_001, 1_000)).toEqual(entries);
		expect(await readCachedAgyModels(path, 2_000, 1_000)).toBeUndefined();
		await rm(path);
		await writeFile(path, "{", "utf8");
		expect(await readCachedAgyModels(path, 1_001)).toBeUndefined();
	});
});
