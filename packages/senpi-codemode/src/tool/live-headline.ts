import { visibleWidth } from "@code-yeongyu/senpi";
import { type EvalCellResult, type EvalLanguage, evalLanguageOrder } from "./types.ts";

const HEADLINED_STATUSES: ReadonlySet<EvalCellResult["status"]> = new Set(["pending", "queued", "running", "detached"]);

/**
 * A collapsed headline never wraps the frame: it gets what the language, state and timing leave on the line. This
 * floor (in screen cells) only keeps a word or two visible in very narrow terminals.
 */
const MIN_HEADLINE_CELLS = 8;

export function leadsWithHeadline(status: EvalCellResult["status"]): boolean {
	return HEADLINED_STATUSES.has(status);
}

/**
 * What an in-progress cell is doing, in one line: its summary, or else the first non-blank line of its code (the
 * oh-my-pi fallback), or an ellipsis while the arguments are still streaming in. Collapsed rows cut it to
 * `maxCells` screen cells (a wide character takes two), so the headline stays one line.
 */
export function liveHeadline(
	summary: string | undefined,
	code: string | undefined,
	maxCells: number | undefined,
): string {
	const text = summary?.trim() || firstCodeLine(code) || "…";
	const limit = maxCells === undefined ? undefined : Math.max(MIN_HEADLINE_CELLS, maxCells);
	if (limit === undefined || visibleWidth(text) <= limit) return text;
	return `${cellPrefix(text, limit - 1)}…`;
}

// A plain cut by screen cells: the headline is styled by the caller, so no reset codes may be inserted here.
function cellPrefix(text: string, cells: number): string {
	let kept = "";
	let used = 0;
	for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
		const width = visibleWidth(segment);
		if (used + width > cells) break;
		kept += segment;
		used += width;
	}
	return kept;
}

export function knownLanguage(language: unknown): EvalLanguage | undefined {
	return evalLanguageOrder.find((known) => known === language);
}

function firstCodeLine(code: string | undefined): string | undefined {
	return code
		?.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0);
}
