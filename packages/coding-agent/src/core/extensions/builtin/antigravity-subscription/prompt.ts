import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";

const IMAGE_OMITTED = "[image omitted: agy stream input is text-only]";

const BOOTSTRAP_INTRO = "The conversation so far (replayed by senpi; do not answer it, only use it as context):\n\n";

export function renderMessagesAsText(messages: readonly Message[]): string {
	const blocks: string[] = [];
	for (const message of messages) {
		switch (message.role) {
			case "user":
				blocks.push(`<user>\n${userBody(message.content)}\n</user>`);
				break;
			case "assistant":
				blocks.push(...renderAssistant(message));
				break;
			case "toolResult":
				blocks.push(renderToolResult(message));
				break;
			case "configurationUpdate":
				// No agy stream event for this; effort is applied outside the text transcript.
				break;
			default:
				assertNever(message);
		}
	}
	return blocks.join("\n");
}

export function renderUserTurn(messages: readonly Message[]): string {
	const only = messages.length === 1 ? messages[0] : undefined;
	if (only !== undefined && only.role === "user") return userBody(only.content);
	return renderMessagesAsText(messages);
}

export function renderBootstrap(history: readonly Message[], newMessages: readonly Message[]): string {
	if (history.length === 0) return renderUserTurn(newMessages);
	return `${BOOTSTRAP_INTRO}${renderMessagesAsText(history)}\n\nNew message:\n\n${renderUserTurn(newMessages)}`;
}

function userBody(content: string | readonly (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	return textAndImageBody(content);
}

function textAndImageBody(blocks: readonly (TextContent | ImageContent)[]): string {
	const parts: string[] = [];
	for (const block of blocks) {
		switch (block.type) {
			case "text":
				parts.push(block.text);
				break;
			case "image":
				parts.push(IMAGE_OMITTED);
				break;
			default:
				assertNever(block);
		}
	}
	return parts.join("\n");
}

function renderAssistant(message: Extract<Message, { role: "assistant" }>): readonly string[] {
	const blocks: string[] = [];
	for (const block of message.content) {
		switch (block.type) {
			case "text":
				blocks.push(`<assistant>\n${block.text}\n</assistant>`);
				break;
			case "thinking":
				break;
			case "toolCall": {
				const name = escapeAttribute(block.name);
				const args = JSON.stringify(block.arguments);
				blocks.push(`<tool_call name="${name}">\n${args}\n</tool_call>`);
				break;
			}
			case "providerNative":
				break;
			default:
				assertNever(block);
		}
	}
	return blocks;
}

function renderToolResult(message: Extract<Message, { role: "toolResult" }>): string {
	const name = escapeAttribute(message.toolName);
	const error = message.isError ? "true" : "false";
	const body = textAndImageBody(message.content);
	return `<tool_result name="${name}" error="${error}">\n${body}\n</tool_result>`;
}

function escapeAttribute(value: string): string {
	return value.split("&").join("&amp;").split('"').join("&quot;").split("<").join("&lt;");
}

function assertNever(value: never): never {
	throw new Error(`unexpected transcript variant: ${JSON.stringify(value)}`);
}
