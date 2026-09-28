import { spawn } from "node:child_process";
import { agyChildEnvironment } from "./environment.ts";
import { resolveAgyExecutable } from "./executable.ts";
import { type AgyModelEntry, parseAgyModels } from "./models.ts";

const AMBIENT_STATUS_TTL_MS = 30_000;
const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
const MAX_STDOUT_BYTES = 256 * 1024;

export type AgyProbeResult = { ok: boolean; stdout: string };

export type ProbeChild = {
	stdout: { on(event: "data", listener: (chunk: Uint8Array | string) => void): unknown };
	once(event: "error", listener: (error: Error) => void): unknown;
	once(event: "close", listener: (code: number | null) => void): unknown;
	kill(signal: "SIGKILL"): unknown;
};

export function createAmbientAgyAuthStatusReader(
	probe: () => Promise<boolean>,
	now: () => number = Date.now,
	ttlMs = AMBIENT_STATUS_TTL_MS,
): (signal?: AbortSignal) => Promise<boolean> {
	let cached: { at: number; value: boolean } | undefined;
	let inFlight: Promise<boolean> | undefined;
	const startProbe = (): Promise<boolean> => {
		const status = probe().then((value) => {
			cached = { at: now(), value };
			return value;
		});
		inFlight = status;
		const clear = () => {
			if (inFlight === status) inFlight = undefined;
		};
		void status.then(clear, clear);
		return status;
	};
	return (signal) => {
		if (signal?.aborted) return Promise.reject(signal.reason);
		if (cached && now() - cached.at < ttlMs) return Promise.resolve(cached.value);
		return untilAborted(inFlight ?? startProbe(), signal);
	};
}

function untilAborted(status: Promise<boolean>, signal: AbortSignal | undefined): Promise<boolean> {
	if (signal === undefined) return status;
	if (signal.aborted) return Promise.reject(signal.reason);
	const abortController = new AbortController();
	const aborted = new Promise<never>((_resolve, reject) => {
		signal.addEventListener("abort", () => reject(signal.reason), {
			once: true,
			signal: abortController.signal,
		});
	});
	return Promise.race([status, aborted]).finally(() => abortController.abort());
}

export type ProbeAgyModelsOptions = {
	executable: string;
	env: Record<string, string>;
	timeoutMs?: number;
	spawnProbe?: (command: string, args: readonly string[], env: Record<string, string>) => ProbeChild;
};

export async function probeAgyModels(options: ProbeAgyModelsOptions): Promise<AgyProbeResult> {
	const { executable, env } = options;
	const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
	const spawnProbe =
		options.spawnProbe ??
		((command, args, childEnv) =>
			spawn(command, [...args], {
				stdio: ["ignore", "pipe", "ignore"],
				windowsHide: true,
				env: childEnv,
			}) as ProbeChild);
	let child: ProbeChild;
	try {
		child = spawnProbe(executable, ["models"], env);
	} catch {
		return { ok: false, stdout: "" };
	}

	return new Promise((resolve) => {
		let settled = false;
		let stdout = "";
		let stdoutBytes = 0;
		const finish = (ok: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(deadline);
			resolve({ ok, stdout });
		};
		const deadline = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {
				finish(false);
			} finally {
				finish(false);
			}
		}, timeoutMs);
		deadline.unref?.();
		child.stdout.on("data", (chunk) => {
			if (stdoutBytes >= MAX_STDOUT_BYTES) return;
			const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
			const remaining = MAX_STDOUT_BYTES - stdoutBytes;
			const bytes = Buffer.from(text);
			const kept = bytes.subarray(0, remaining);
			stdout += kept.toString("utf8");
			stdoutBytes += kept.length;
		});
		child.once("error", () => finish(false));
		child.once("close", (code) => finish(code === 0 && parseAgyModels(stdout).length > 0));
	});
}

export type ProbeAmbientAgyAuthStatusOptions = {
	settings?: { executablePath?: string };
	timeoutMs?: number;
	env?: Record<string, string>;
	resolveExecutable?: (settings: { executablePath?: string }) => string;
	spawnProbe?: ProbeAgyModelsOptions["spawnProbe"];
};

let mostRecentDefaultProbeModels: readonly AgyModelEntry[] | undefined;

export async function probeAmbientAgyAuthStatus(options: ProbeAmbientAgyAuthStatusOptions = {}): Promise<boolean> {
	let executable: string;
	try {
		executable = (options.resolveExecutable ?? resolveAgyExecutable)(options.settings ?? {});
	} catch {
		return false;
	}
	const result = await probeAgyModels({
		executable,
		env: options.env ?? agyChildEnvironment(),
		timeoutMs: options.timeoutMs,
		spawnProbe: options.spawnProbe,
	});
	if (result.ok && options.resolveExecutable === undefined && options.spawnProbe === undefined) {
		mostRecentDefaultProbeModels = parseAgyModels(result.stdout);
	}
	return result.ok;
}

export const readAmbientAgyAuthStatus = createAmbientAgyAuthStatusReader(() => probeAmbientAgyAuthStatus());

export function lastProbedModels(): readonly AgyModelEntry[] | undefined {
	return mostRecentDefaultProbeModels;
}
