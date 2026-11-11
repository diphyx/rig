/* The e2e runner, on the host: `pnpm test:e2e:run <stage>...`. `check` and `sweep` first, each alone; the stages that make machines then all at once. `all` is check, then every one of them. */
import { all, unique } from "radash";

import { fail, log } from "./lib/log.ts";
import { DONE } from "./lib/stage.ts";
import * as check from "./stages/check.ts";
import * as failover from "./stages/failover.ts";
import * as machine from "./stages/machine.ts";
import * as recover from "./stages/recover.ts";
import * as sweep from "./stages/sweep.ts";

const STAGES: Record<string, { run: () => Promise<boolean> }> = { check, sweep, machine, failover, recover };

/* Run first, each alone: the free gate, and the net. */
const FIRST = ["sweep", "check"];

const ALL = ["check", "machine", "failover", "recover"];

const asked = process.argv.slice(2);
const names = unique(
    asked.length === 0
        ? ["check"]
        : asked.flatMap((name) => {
              return name === "all" ? ALL : [name];
          }),
);

for (const name of names) {
    if (!STAGES[name]) {
        fail(`${name} is a stage: ${[...Object.keys(STAGES), "all"].join(", ")}`);
    }
}

const started = Date.now();

/* `sweep` is no stage: an error of its ends the run. */
for (const name of FIRST.filter((first) => {
    return names.includes(first);
})) {
    await STAGES[name]!.run();
}

await all(
    names
        .filter((name) => {
            return !FIRST.includes(name);
        })
        .map((name) => {
            return STAGES[name]!.run();
        }),
);

for (const one of DONE) {
    log(`${one.passed ? "✓" : "✗"} ${one.name} ${one.seconds}s`);
}

const passed = DONE.every((one) => {
    return one.passed;
});

process.exitCode = passed ? 0 : 1;
log(`e2e: ${passed ? "passed" : "failed"} in ${Math.round((Date.now() - started) / 1000)}s`);
