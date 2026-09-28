import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
	createAmbientAgyAuthStatusReader,
	type ProbeChild,
	probeAgyModels,
} from "../../src/core/extensions/builtin/antigravity-subscription/availability.ts";

describe("Antigravity ambient auth availability", () => {
	it("caches values through the TTL and then probes again", async () => {
		let now = 1_000;
		const probe = vi.fn(async () => true);
		const read = createAmbientAgyAuthStatusReader(probe, () => now, 30_000);
		expect(await read()).toBe(true);
		now += 29_999;
		expect(await read()).toBe(true);
		now += 1;
		expect(await read()).toBe(true);
		expect(probe).toHaveBeenCalledTimes(2);
	});

	it("shares one in-flight probe and lets one caller abort", async () => {
		let release: ((value: boolean) => void) | undefined;
		const probe = vi.fn(() => new Promise<boolean>((resolve) => (release = resolve)));
		const read = createAmbientAgyAuthStatusReader(probe);
		const controller = new AbortController();
		const aborted = read(controller.signal);
		const waiting = read();
		controller.abort(new Error("caller stopped"));
		await expect(aborted).rejects.toThrow("caller stopped");
		release?.(true);
		expect(await waiting).toBe(true);
		expect(probe).toHaveBeenCalledTimes(1);
	});

	it("does not cache a rejected probe", async () => {
		const probe = vi.fn().mockRejectedValueOnce(new Error("probe failed")).mockResolvedValueOnce(true);
		const read = createAmbientAgyAuthStatusReader(probe);
		await expect(read()).rejects.toThrow("probe failed");
		expect(await read()).toBe(true);
	});

	it("kills a hung models probe at its deadline", async () => {
		class FakeChild extends EventEmitter {
			stdout = new EventEmitter();
			killed = false;
			kill(signal: "SIGKILL") {
				expect(signal).toBe("SIGKILL");
				this.killed = true;
			}
		}
		const child = new FakeChild();
		const result = await probeAgyModels({
			executable: "/fake/agy",
			env: {},
			timeoutMs: 10,
			spawnProbe: () => child as unknown as ProbeChild,
		});
		expect(result).toEqual({ ok: false, stdout: "" });
		expect(child.killed).toBe(true);
	});

	it("returns false for non-zero exit and captures bounded stdout", async () => {
		const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; kill: () => void };
		child.stdout = new EventEmitter();
		child.kill = () => {};
		const result = probeAgyModels({
			executable: "/fake/agy",
			env: {},
			spawnProbe: () => {
				queueMicrotask(() => {
					child.stdout.emit("data", "gemini-3.8-flash-low\tGemini 3.8 Flash Low\n");
					child.emit("close", 1);
				});
				return child as unknown as ProbeChild;
			},
		});
		expect(await result).toEqual({
			ok: false,
			stdout: "gemini-3.8-flash-low\tGemini 3.8 Flash Low\n",
		});
	});
});
