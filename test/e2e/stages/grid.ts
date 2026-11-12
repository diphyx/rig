/* A few cents: the grid worker for real: a job machine on each cloud, its node set up at first boot; a job run on it from this machine's hub, and the node's beats back to it. Every cloud at once. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sleep } from "radash";

import { Distro, Status } from "@diphyx/rig";
import { createGrid } from "@diphyx/rig-grid";

import { fail, log, ok } from "../lib/log.ts";
import { APP, CLOUDS, LISTEN, providerOf } from "../lib/clouds.ts";
import { myIp } from "../lib/ssh.ts";
import { everyOf, stage } from "../lib/stage.ts";

/* How long a job may wait for its node: the machine's boot, grid installed, its node started. */
const PLACED = 10 * 60_000;

/* How long the hub waits for a node's first beat: one every 5 s (grid spec §6). */
const BEAT = { every: 5_000, tries: 12 };

/* The one cmd each node runs: the pushed note back, and the machine's arch after it. */
const CMDS = {
    note: {
        exec: ["sh", "-c", "mkdir -p out && cat in/note.txt > out/note.txt && uname -m >> out/note.txt"],
        timeout: "1m",
    },
};

export function run(): Promise<boolean> {
    const ip = myIp();

    return everyOf(CLOUDS, (cloud) => {
        const provider = providerOf(cloud);
        const kind = `job-${cloud}`;
        const tag = `e2e-${cloud}`;
        const note = `${APP} on ${cloud}`;

        /* The hub: on this machine, at its IP, listening for its nodes' beats; its key `./.rig/grid/hub.key`, made once. */
        const grid = createGrid({ ip, listen: LISTEN[cloud]! });

        /* The node, by its machine's name, beating: waited for up to a minute. */
        const beating = async (name: string): Promise<boolean> => {
            for (let tries = 0; tries < BEAT.tries; tries += 1) {
                const found = grid.nodes({ tag, beating: true, lost: false }).some((node) => {
                    return node.name === name;
                });

                if (found) {
                    return true;
                }

                await sleep(BEAT.every);
            }

            return false;
        };

        const kinds = [
            provider.presets.small({
                name: kind,
                distro: { name: Distro.UBUNTU },
                worker: { tags: [tag], cmds: CMDS, signal: true },
                life: "1h",
            }),
        ];

        return stage(`${cloud}: grid job`, { kinds, workers: [grid] }, async (rig) => {
            const made = (await rig.machine.create(kind)) ?? fail("no room for a small demand machine");

            ok(made.worker?.tags.includes(tag), `created ${made.id}: ${made.type} in ${made.zone}, tagged ${tag}`);

            const machine = await rig.machine.wait(made.id, Status.RUNNING);

            ok(machine.status === Status.RUNNING, `running at ${machine.ip?.public}`);

            const folder = mkdtempSync(join(tmpdir(), "rig-e2e-grid-"));

            mkdirSync(join(folder, "in"));
            writeFileSync(join(folder, "in", "note.txt"), `${note}\n`);
            log("waiting for its node: first boot, grid installed");

            /* The core leaves its workers open: the hub's connections closed here, and the job's files gone. */
            try {
                const outcome = await grid.run(
                    {
                        tag,
                        push: [{ from: join(folder, "in"), to: "in" }],
                        steps: [{ cmd: "note" }],
                        pull: [{ path: "out", into: join(folder, "pulled") }],
                    },
                    { signal: AbortSignal.timeout(PLACED) },
                );

                ok(
                    outcome.state === "done",
                    `job ${outcome.name}: ${outcome.state} on ${outcome.node} ${outcome.message}`,
                );

                /* A job's node, by its address: the one `grid.recover` takes. */
                ok(outcome.node?.startsWith(`${machine.ip?.public}:`), `it ran on the machine's node: ${outcome.node}`);

                /* The node dials the hub too, with signal: its beats. */
                ok(await beating(made.name), `its node dials the hub: it beats, from ${machine.ip?.public}`);

                /* The pulled folder: in place of `into`, or under it. */
                const pulled = [join(folder, "pulled", "note.txt"), join(folder, "pulled", "out", "note.txt")].find(
                    existsSync,
                );

                const [written = "", arch = ""] = (pulled ? readFileSync(pulled, "utf8") : "").trim().split("\n");

                ok(written === note, `pushed, run, pulled: "${written}" on ${arch}`);
            } finally {
                await grid.close();
                rmSync(folder, { recursive: true, force: true });
            }
        });
    });
}
