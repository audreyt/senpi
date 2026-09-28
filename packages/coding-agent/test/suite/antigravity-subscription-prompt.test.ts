import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	renderBootstrap,
	renderMessagesAsText,
	renderUserTurn,
} from "../../src/core/extensions/builtin/antigravity-subscription/prompt.ts";

const IMAGE_OMITTED = "[image omitted: agy stream input is text-only]";

function user(content: UserMessage["content"]): UserMessage {
	return { role: "user", content, timestamp: 0 };
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "antigravity-subscription",
		provider: "antigravity-subscription",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function toolResult(toolName: string, content: ToolResultMessage["content"], isError: boolean): ToolResultMessage {
	return { role: "toolResult", toolCallId: "call-1", toolName, content, isError, timestamp: 0 };
}

describe("renderMessagesAsText", () => {
	it("wraps a text user message", () => {
		expect(renderMessagesAsText([user("hello")])).toBe("<user>\nhello\n</user>");
	});

	it("joins multi-block user text and replaces images", () => {
		const message = user([
			{ type: "text", text: "see this" },
			{ type: "image", data: "IMGDATA", mimeType: "image/png" },
			{ type: "text", text: "and this" },
		]);

		const rendered = renderMessagesAsText([message]);

		expect(rendered).toBe(`<user>\nsee this\n${IMAGE_OMITTED}\nand this\n</user>`);
		expect(rendered).not.toContain("IMGDATA");
		expect(rendered).not.toContain("image/png");
	});

	it("renders assistant text and tool calls and drops thinking", () => {
		const rendered = renderMessagesAsText([
			assistant([
				{ type: "thinking", thinking: "SECRET_THOUGHT" },
				{ type: "text", text: "I'll read it." },
				{ type: "toolCall", id: "call-secret", name: "read", arguments: { path: "a.txt", recursive: false } },
			]),
		]);

		expect(rendered).toBe(
			'<assistant>\nI\'ll read it.\n</assistant>\n<tool_call name="read">\n{"path":"a.txt","recursive":false}\n</tool_call>',
		);
		expect(rendered).not.toContain("SECRET_THOUGHT");
		expect(rendered).not.toContain("call-secret");
	});

	it("escapes tool-call names that would break the attribute", () => {
		const rendered = renderMessagesAsText([
			assistant([{ type: "toolCall", id: "c1", name: 'read"&<x', arguments: {} }]),
		]);

		expect(rendered).toBe('<tool_call name="read&quot;&amp;&lt;x">\n{}\n</tool_call>');
	});

	it("renders tool results with the error flag and replaces images", () => {
		const ok = toolResult("read", [{ type: "text", text: "file body" }], false);
		const failed = toolResult("read", [{ type: "text", text: "nope" }], true);
		const pictured = toolResult(
			"read",
			[
				{ type: "text", text: "before" },
				{ type: "image", data: "IMGDATA", mimeType: "image/jpeg" },
			],
			false,
		);

		expect(renderMessagesAsText([ok])).toBe('<tool_result name="read" error="false">\nfile body\n</tool_result>');
		expect(renderMessagesAsText([failed])).toBe('<tool_result name="read" error="true">\nnope\n</tool_result>');
		const picturedText = renderMessagesAsText([pictured]);
		expect(picturedText).toBe(`<tool_result name="read" error="false">\nbefore\n${IMAGE_OMITTED}\n</tool_result>`);
		expect(picturedText).not.toContain("IMGDATA");
	});

	it("drops thinking-only, provider-native, and configuration-update messages", () => {
		const messages: Message[] = [
			assistant([
				{ type: "thinking", thinking: "SECRET_THOUGHT" },
				{ type: "providerNative", subtype: "web_search", raw: { secret: "NATIVE_SECRET" } },
			]),
			{
				role: "configurationUpdate",
				content: [{ type: "text", text: "EFFORT_NOTE" }],
				effort: "high",
				timestamp: 0,
			},
		];

		expect(renderMessagesAsText(messages)).toBe("");
	});
});

describe("renderUserTurn", () => {
	it("returns plain text for a single user message", () => {
		const blocks = user([
			{ type: "text", text: "see this" },
			{ type: "image", data: "IMGDATA", mimeType: "image/png" },
			{ type: "text", text: "and this" },
		]);

		expect(renderUserTurn([user("hello")])).toBe("hello");
		expect(renderUserTurn([blocks])).toBe(`see this\n${IMAGE_OMITTED}\nand this`);
	});

	it("uses the tagged transcript when the turn is not a single user message", () => {
		const rendered = renderUserTurn([
			user("again"),
			toolResult("read", [{ type: "text", text: "file body" }], false),
		]);

		expect(rendered).toBe(
			'<user>\nagain\n</user>\n<tool_result name="read" error="false">\nfile body\n</tool_result>',
		);
	});
});

describe("renderBootstrap", () => {
	it("returns the new turn alone when there is no history", () => {
		expect(renderBootstrap([], [user("ping")])).toBe("ping");
		expect(renderBootstrap([], [user("ping")])).not.toContain("The conversation so far");
	});

	it("replays history and then the new message", () => {
		const history = [user("old"), assistant([{ type: "text", text: "reply" }])];
		const rendered = renderBootstrap(history, [user("new")]);

		expect(rendered).toBe(
			[
				"The conversation so far (replayed by senpi; do not answer it, only use it as context):",
				"",
				"<user>",
				"old",
				"</user>",
				"<assistant>",
				"reply",
				"</assistant>",
				"",
				"New message:",
				"",
				"new",
			].join("\n"),
		);
	});

	it("still emits the replay frame when history renders no text", () => {
		const history = [assistant([{ type: "thinking", thinking: "SECRET_THOUGHT" }])];
		const rendered = renderBootstrap(history, [user("new")]);

		expect(rendered).toContain("The conversation so far");
		expect(rendered).toContain("New message:");
		expect(rendered.endsWith("new")).toBe(true);
		expect(rendered).not.toContain("SECRET_THOUGHT");
	});
});
