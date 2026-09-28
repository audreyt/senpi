import { describe, expect, it } from "vitest";
import { AgyStreamParser, sumUsage } from "../../src/core/extensions/builtin/antigravity-subscription/stream-parser.ts";

const init = JSON.stringify({
	event: "init",
	conversation_id: "conv",
	init: { cwd: "/tmp", tools: [], permission_mode: "request-review", model: "gemini" },
});
const step = JSON.stringify({
	event: "step_update",
	step_update: {
		conversation_id: "conv",
		step_index: 1,
		state: "ACTIVE",
		step_type: "agent_response",
		text_delta: "안녕",
	},
});
const result = JSON.stringify({
	event: "result",
	result: {
		conversation_id: "conv",
		status: "SUCCESS",
		response: "done",
		usage: { input_tokens: "2", output_tokens: 3 },
	},
});

describe("AgyStreamParser", () => {
	it("parses init, step, and result events", () => {
		const parser = new AgyStreamParser();
		expect(parser.push(`${init}\n${step}\n${result}\n`)).toEqual([
			{ type: "init", conversationId: "conv", cwd: "/tmp", model: "gemini" },
			expect.objectContaining({ type: "step", stepIndex: 1, textDelta: "안녕" }),
			expect.objectContaining({
				type: "result",
				status: "SUCCESS",
				response: "done",
				usage: { input_tokens: 2, output_tokens: 3, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
			}),
		]);
	});

	it("handles split lines, split UTF-8, and CRLF", () => {
		const parser = new AgyStreamParser();
		const bytes = Buffer.from(`${step}\r\n`, "utf8");
		const split = bytes.indexOf(Buffer.from("안", "utf8")) + 1;
		expect(parser.push(bytes.subarray(0, split))).toEqual([]);
		expect(parser.push(bytes.subarray(split))).toEqual([
			expect.objectContaining({ type: "step", textDelta: "안녕" }),
		]);
	});

	it("reports malformed JSON and unknown kinds", () => {
		const parser = new AgyStreamParser();
		expect(parser.push("{oops}\n")).toEqual([{ type: "malformed", reason: "invalid_json", sample: "{oops}" }]);
		expect(parser.push('{"event":"future"}\n')).toEqual([{ type: "unknown", event: "future" }]);
	});

	it("resynchronizes after an oversized line", () => {
		const parser = new AgyStreamParser();
		const events = parser.push(`${"x".repeat(1024 * 1024 + 1)}\n${init}\n`);
		expect(events[0]).toMatchObject({ type: "malformed", reason: "line_overflow" });
		expect(events[1]).toMatchObject({ type: "init", conversationId: "conv" });
	});

	it("sums absent and present usage", () => {
		expect(
			sumUsage(undefined, {
				input_tokens: 1,
				output_tokens: 2,
				thinking_tokens: 3,
				cache_read_tokens: 4,
				total_tokens: 10,
			}),
		).toEqual({ input_tokens: 1, output_tokens: 2, thinking_tokens: 3, cache_read_tokens: 4, total_tokens: 10 });
	});
});
