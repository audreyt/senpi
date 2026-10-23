#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "shell-quote";
import { parse as parseYaml } from "yaml";

// CI compiler-selection contract: @typescript/old also exports `tsc`, so a
// successful version probe must identify the direct pinned compiler, not a shim.
test("read parity checks with the pinned TypeScript compiler (senpi#3)", () => {
	const root = new URL("../", import.meta.url);
	const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
	const workflow = parseYaml(
		readFileSync(new URL(".github/workflows/read-summary-binary-parity.yml", root), "utf8"),
	);
	const check = workflow.jobs.parity.steps.find((step) => step.name === "Check and build source");
	const command = check.run.split("\n").find((line) => line.includes("--noEmit"));
	assert(command, "The full root typecheck must remain in the parity job");
	const [executable, ...args] = parse(command);
	const output = execFileSync(executable, args.map((arg) => (arg === "--noEmit" ? "--version" : arg)), {
		cwd: root,
		encoding: "utf8",
	});
	assert.equal(output.trim(), `Version ${manifest.devDependencies.typescript}`);
});
