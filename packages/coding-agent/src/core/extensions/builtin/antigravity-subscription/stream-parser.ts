export type AgyUsage = {
	input_tokens: number;
	output_tokens: number;
	thinking_tokens: number;
	cache_read_tokens: number;
	total_tokens: number;
};

export type AgyEvent =
	| { type: "init"; conversationId: string; cwd?: string; model?: string }
	| {
			type: "step";
			conversationId?: string;
			stepIndex: number;
			state: string;
			stepType: string;
			textDelta?: string;
			toolName?: string;
			toolInfo?: {
				name?: string;
				parameters?: Record<string, unknown>;
				output?: string;
				error?: { type?: string; message?: string };
			};
			usage?: AgyUsage;
	  }
	| {
			type: "result";
			conversationId: string;
			status: string;
			response: string;
			error?: string;
			usage?: AgyUsage;
			deniedActions?: Array<{ action?: string; display_name?: string }>;
	  }
	| { type: "unknown"; event: string }
	| { type: "malformed"; reason: "invalid_json" | "line_overflow" | "shape"; sample: string };

const MAX_PENDING_CHARACTERS = 1024 * 1024;

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
	return typeof value[key] === "string" ? value[key] : undefined;
}

function usage(value: unknown): AgyUsage | undefined {
	const data = record(value);
	if (!data) return undefined;
	const number = (key: keyof AgyUsage) => {
		const parsed = Number(data[key]);
		return Number.isFinite(parsed) ? parsed : 0;
	};
	return {
		input_tokens: number("input_tokens"),
		output_tokens: number("output_tokens"),
		thinking_tokens: number("thinking_tokens"),
		cache_read_tokens: number("cache_read_tokens"),
		total_tokens: number("total_tokens"),
	};
}

function parseLine(line: string): AgyEvent {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return { type: "malformed", reason: "invalid_json", sample: line.slice(0, 2048) };
	}
	const root = record(parsed);
	const event = stringField(root ?? {}, "event");
	if (!root || !event) return { type: "malformed", reason: "shape", sample: line.slice(0, 2048) };
	if (event === "init") {
		const data = record(root.init);
		const conversationId = stringField(root, "conversation_id");
		if (!data || !conversationId) return { type: "malformed", reason: "shape", sample: line.slice(0, 2048) };
		return {
			type: "init",
			conversationId,
			...(stringField(data, "cwd") !== undefined ? { cwd: stringField(data, "cwd") } : {}),
			...(stringField(data, "model") !== undefined ? { model: stringField(data, "model") } : {}),
		};
	}
	if (event === "step_update") {
		const data = record(root.step_update);
		if (
			!data ||
			typeof data.step_index !== "number" ||
			typeof data.state !== "string" ||
			typeof data.step_type !== "string"
		) {
			return { type: "malformed", reason: "shape", sample: line.slice(0, 2048) };
		}
		const rawInfo = record(data.tool_info);
		const rawError = record(rawInfo?.error);
		const info = rawInfo
			? {
					...(stringField(rawInfo, "name") !== undefined ? { name: stringField(rawInfo, "name") } : {}),
					...(record(rawInfo.parameters) ? { parameters: record(rawInfo.parameters) } : {}),
					...(stringField(rawInfo, "output") !== undefined ? { output: stringField(rawInfo, "output") } : {}),
					...(rawError
						? {
								error: {
									...(stringField(rawError, "type") !== undefined
										? { type: stringField(rawError, "type") }
										: {}),
									...(stringField(rawError, "message") !== undefined
										? { message: stringField(rawError, "message") }
										: {}),
								},
							}
						: {}),
				}
			: undefined;
		return {
			type: "step",
			...(stringField(data, "conversation_id") !== undefined
				? { conversationId: stringField(data, "conversation_id") }
				: {}),
			stepIndex: data.step_index,
			state: data.state,
			stepType: data.step_type,
			...(stringField(data, "text_delta") !== undefined ? { textDelta: stringField(data, "text_delta") } : {}),
			...(stringField(data, "tool_name") !== undefined ? { toolName: stringField(data, "tool_name") } : {}),
			...(info ? { toolInfo: info } : {}),
			...(usage(data.usage) ? { usage: usage(data.usage) } : {}),
		};
	}
	if (event === "result") {
		const data = record(root.result);
		const conversationId = stringField(data ?? {}, "conversation_id");
		const status = stringField(data ?? {}, "status");
		const response = stringField(data ?? {}, "response");
		if (!data || !conversationId || !status || response === undefined) {
			return { type: "malformed", reason: "shape", sample: line.slice(0, 2048) };
		}
		return {
			type: "result",
			conversationId,
			status,
			response,
			...(stringField(data, "error") !== undefined ? { error: stringField(data, "error") } : {}),
			...(usage(data.usage) ? { usage: usage(data.usage) } : {}),
			...(Array.isArray(data.denied_actions)
				? {
						deniedActions: data.denied_actions.flatMap((item) => {
							const action = record(item);
							return action
								? [
										{
											...(stringField(action, "action") ? { action: stringField(action, "action") } : {}),
											...(stringField(action, "display_name")
												? { display_name: stringField(action, "display_name") }
												: {}),
										},
									]
								: [];
						}),
					}
				: {}),
		};
	}
	return { type: "unknown", event };
}

export class AgyStreamParser {
	private pending = "";
	private overflowSample = "";
	private discarding = false;
	private discardingAtChunkStart = false;

	push(chunk: string | Buffer): AgyEvent[] {
		let text: string;
		try {
			text = typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
		} catch {
			return [{ type: "malformed", reason: "shape", sample: "" }];
		}
		const events: AgyEvent[] = [];
		const parts = text.split("\n");
		for (let index = 0; index < parts.length; index++) {
			const part = parts[index];
			if (this.discarding) {
				if (this.discardingAtChunkStart) {
					this.discardingAtChunkStart = false;
					const newlineIndex = text.indexOf("\n");
					if (newlineIndex === -1) continue;
					this.discarding = false;
					const remainder = text.slice(newlineIndex + 1);
					const remainingParts = remainder.split("\n");
					for (let remainingIndex = 0; remainingIndex < remainingParts.length; remainingIndex++) {
						const remainingPart = remainingParts[remainingIndex];
						if (remainingIndex < remainingParts.length - 1) {
							const line = remainingPart.endsWith("\r") ? remainingPart.slice(0, -1) : remainingPart;
							if (line.trim()) events.push(parseLine(line));
						} else {
							this.pending = remainingPart;
						}
					}
					break;
				}
				if (index < parts.length - 1) {
					this.discarding = false;
					continue;
				}
				continue;
			}
			if (part.length > MAX_PENDING_CHARACTERS || this.pending.length + part.length > MAX_PENDING_CHARACTERS) {
				this.overflowSample = (this.pending + part).slice(0, 2048);
				this.pending = "";
				this.discarding = true;
				this.discardingAtChunkStart = index === 0;
				events.push({ type: "malformed", reason: "line_overflow", sample: this.overflowSample });
				continue;
			}
			this.pending += part;
			if (index < parts.length - 1) {
				const line = this.pending.endsWith("\r") ? this.pending.slice(0, -1) : this.pending;
				this.pending = "";
				if (line.trim()) events.push(parseLine(line));
			}
		}
		return events;
	}

	flush(): AgyEvent[] {
		const tail = this.decoder.decode();
		const pending = this.pending + tail;
		this.pending = "";
		if (this.discarding || !pending.trim()) return [];
		const line = pending.endsWith("\r") ? pending.slice(0, -1) : pending;
		return [parseLine(line)];
	}

	private readonly decoder = new TextDecoder();
}

export function sumUsage(a: AgyUsage | undefined, b: AgyUsage | undefined): AgyUsage {
	return {
		input_tokens: (a?.input_tokens ?? 0) + (b?.input_tokens ?? 0),
		output_tokens: (a?.output_tokens ?? 0) + (b?.output_tokens ?? 0),
		thinking_tokens: (a?.thinking_tokens ?? 0) + (b?.thinking_tokens ?? 0),
		cache_read_tokens: (a?.cache_read_tokens ?? 0) + (b?.cache_read_tokens ?? 0),
		total_tokens: (a?.total_tokens ?? 0) + (b?.total_tokens ?? 0),
	};
}
