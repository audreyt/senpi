import { readFile, writeFile } from "node:fs/promises";
import type { ProviderModelConfig } from "../../types.ts";

const ANSI_ESCAPE_SEQUENCE = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const MODEL_LINE = /^([a-z0-9][a-z0-9.-]*)(?:\t+| {2,})(.+)$/;
const DAY_MS = 24 * 60 * 60 * 1_000;

export type AgyModelEntry = { id: string; label: string };

export const STATIC_AGY_MODELS: readonly AgyModelEntry[] = [
	{ id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
	{ id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
	{ id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" },
	{ id: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (High)" },
	{ id: "gemini-3.7-flash-medium", label: "Gemini 3.7 Flash (Medium)" },
	{ id: "gemini-3.7-flash-low", label: "Gemini 3.7 Flash (Low)" },
	{ id: "gemini-3.6-flash-high", label: "Gemini 3.6 Flash (High)" },
	{ id: "gemini-3.6-flash-medium", label: "Gemini 3.6 Flash (Medium)" },
	{ id: "gemini-3.6-flash-low", label: "Gemini 3.6 Flash (Low)" },
	{ id: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (High)" },
	{ id: "gemini-3.1-pro-low", label: "Gemini 3.1 Pro (Low)" },
	{ id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)" },
	{ id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)" },
	{ id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" },
];

export function parseAgyModels(stdout: string): AgyModelEntry[] {
	const entries: AgyModelEntry[] = [];
	for (const line of stdout.replace(ANSI_ESCAPE_SEQUENCE, "").split(/\r?\n/)) {
		const match = MODEL_LINE.exec(line);
		if (match) entries.push({ id: match[1]!, label: match[2]!.trim() });
	}
	return entries;
}

export function toProviderModels(entries: readonly AgyModelEntry[]): ProviderModelConfig[] {
	return entries.map(({ id, label }) => ({
		id,
		name: `${label} via Antigravity`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: id.startsWith("gemini-") ? 1_000_000 : 200_000,
		maxTokens: 64_000,
	}));
}

export async function readCachedAgyModels(
	path: string,
	now: number,
	ttlMs = DAY_MS,
): Promise<AgyModelEntry[] | undefined> {
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null || !("fetchedAt" in parsed) || !("entries" in parsed)) {
			return undefined;
		}
		const { fetchedAt, entries } = parsed;
		if (
			typeof fetchedAt !== "number" ||
			!Number.isFinite(fetchedAt) ||
			now < fetchedAt ||
			now - fetchedAt >= ttlMs ||
			!Array.isArray(entries) ||
			!entries.every(
				(entry) =>
					typeof entry === "object" &&
					entry !== null &&
					"id" in entry &&
					typeof entry.id === "string" &&
					"label" in entry &&
					typeof entry.label === "string",
			)
		) {
			return undefined;
		}
		return entries as AgyModelEntry[];
	} catch {
		return undefined;
	}
}

export async function writeCachedAgyModels(
	path: string,
	entries: readonly AgyModelEntry[],
	now: number,
): Promise<void> {
	await writeFile(path, JSON.stringify({ fetchedAt: now, entries }), "utf8");
}
