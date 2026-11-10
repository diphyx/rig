import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isString, sleep, tryit } from "radash";

import { GridLost, RETRY_EVERY_MS, runAttempt } from "./job.js";
import { NodeLink } from "./nodes.js";
import { shareProblem } from "./share.js";
import { TarStore } from "./tars.js";
import { GridHalted, pullTar } from "./transfer.js";
import { GridReject } from "./wire.js";

import type { GridJob, GridOutcome, GridPull, GridRunOptions } from "./job.js";
import type { GridNodeEntry, Log } from "./nodes.js";
import type { Keypair } from "./noise.js";
import type { PackedPush } from "./tars.js";

const RECOVER_WAIT_MS = 15_000;

const noLog: Log = () => {};

function nameOf(job: GridJob): string {
    return job.steps
        .map((step) => {
            return step.cmd;
        })
        .join(", ");
}

/* The share pushes a node already had, and those it kept: "1 hit, 1 installed"; empty without any. */
function sharesOf(outcome: GridOutcome): string {
    const counts = (["hit", "installed"] as const).map((how) => {
        const count = outcome.pushed.filter((each) => {
            return each.how === how;
        }).length;

        return count ? `${count} ${how}` : "";
    });

    return counts.filter(Boolean).join(", ");
}

/* One line per job: how it ended, how long it took, where, and its shares. */
function report(job: GridJob, outcome: GridOutcome, started: number, log: Log) {
    const took = `${((Date.now() - started) / 1000).toFixed(1)} s`;
    const where = outcome.node ? ` on ${outcome.node}` : "";
    const shares = sharesOf(outcome);

    if (outcome.state === "done") {
        log(`${nameOf(job)} done in ${took}${where}${shares ? `; shares: ${shares}` : ""}`);
    } else {
        log(`${nameOf(job)} ${outcome.state} in ${took}${where}: ${outcome.message}`);
    }
}

/* A job that ended before an attempt could tell its steps' own end. */
function ended(job: GridJob, state: "failed" | "stopped", message: string, node: string | null = null): GridOutcome {
    const steps = job.steps.map((step) => {
        return { cmd: step.cmd, state: "idle" as const, message: "" };
    });

    return { state, message, node, steps, pushed: [], files: [] };
}

/** The hub side of grid/2: it knows the nodes, places each job on one with its tag, and runs it there. */
export class GridHub {
    readonly links: NodeLink[] = [];
    private readonly tars: TarStore;
    private readonly log: Log;
    /* Tags no more nodes come for: a job waiting for one of them fails. */
    private readonly spentTags = new Set<string>();

    constructor(
        private readonly local: Keypair,
        options: { tars?: string; log?: Log } = {},
    ) {
        this.tars = new TarStore(options.tars ?? path.join(tmpdir(), "grid-tars"));
        this.log = options.log ?? noLog;
    }

    /** A node to dial, by its machine's name; one already known is updated; its tags take jobs again. */
    add(entry: GridNodeEntry) {
        const known = this.links.find((link) => {
            return link.entry.name === entry.name;
        });

        /* The same machine again: updated in place, so a job running on it keeps its node. */
        if (known) {
            known.update(entry);
        } else {
            this.links.push(new NodeLink(entry, this.local, this.log));
        }

        for (const tag of entry.tags) {
            this.spentTags.delete(tag);
        }
    }

    /** Forgets a node, by its machine's name; one not known is done. */
    drop(name: string) {
        const index = this.links.findIndex((link) => {
            return link.entry.name === name;
        });

        if (index !== -1) {
            this.links[index]!.close();
            this.links.splice(index, 1);
        }
    }

    /** No more nodes come for these tags: a job waiting for one no node has fails. */
    spent(tags: string[]) {
        for (const tag of tags) {
            this.spentTags.add(tag);
        }
    }

    /** The node at this IP, for a connection it dials in, with signal. */
    nodeAt(ip: string): NodeLink | undefined {
        return this.links.find((link) => {
            return link.entry.ip === ip;
        });
    }

    /* A node that still answers first; for a job with a share push, one with its share on before the others. */
    private candidates(tag: string, isSharing: boolean): NodeLink[] {
        const rank = (link: NodeLink) => {
            return Number(link.isLost) * 2 + Number(isSharing && !link.isSharing);
        };

        return this.links
            .filter((link) => {
                return link.serves(tag);
            })
            .sort((left, right) => {
                return rank(left) - rank(right);
            });
    }

    /* Opens the job on the first node that takes it; while none does, the job waits. */
    private async place(job: GridJob, signal: AbortSignal | undefined) {
        const isSharing = Boolean(
            job.push?.some((push) => {
                return push.isShared;
            }),
        );

        let isWaitNoted = false;

        while (!signal?.aborted) {
            let isFull = false;

            /* No node has the tag, and none comes for it (rig spec §22.1, `spent`). */
            if (this.spentTags.has(job.tag) && this.candidates(job.tag, isSharing).length === 0) {
                return "spent" as const;
            }

            for (const link of this.candidates(job.tag, isSharing)) {
                const [problem, opened] = await tryit(async () => {
                    return (await link.connect()).request("open", { tag: job.tag });
                })();

                if (!problem && isString(opened.job)) {
                    link.seen();

                    return { link, nodeJob: opened.job };
                }

                if (problem instanceof GridReject) {
                    isFull ||= problem.reason === "full";
                } else {
                    link.failed(problem);
                }
            }

            /* Waiting for room is worth one line; a node that does not answer has told its own. */
            if (isFull && !isWaitNoted) {
                this.log(`${nameOf(job)} waits: no ${job.tag} node has room`);
                isWaitNoted = true;
            }

            await sleep(RETRY_EVERY_MS);
        }

        return null;
    }

    /* Every push packed once, before the job is placed: each attempt sends the same tars. */
    private async pack(job: GridJob): Promise<PackedPush[]> {
        const packed: PackedPush[] = [];

        const [problem] = await tryit(async () => {
            for (const push of job.push ?? []) {
                packed.push(await this.tars.pack(push.from));
            }
        })();

        if (problem) {
            await this.tars.release(packed);

            throw problem;
        }

        return packed;
    }

    async run(job: GridJob, options: GridRunOptions = {}): Promise<GridOutcome> {
        const started = Date.now();
        const outcome = await this.runJob(job, options);

        report(job, outcome, started, this.log);

        return outcome;
    }

    private async runJob(job: GridJob, options: GridRunOptions): Promise<GridOutcome> {
        const problem = shareProblem(job);

        if (problem) {
            return ended(job, "failed", problem);
        }

        const [packProblem, packed] = await tryit(() => {
            return this.pack(job);
        })();

        if (packProblem) {
            return ended(job, "failed", `push: ${packProblem.message}`);
        }

        return this.attempts(job, packed, options).finally(() => {
            return this.tars.release(packed);
        });
    }

    /* Each attempt on a node that takes the job; a lost node runs it again from the start elsewhere. */
    private async attempts(job: GridJob, packed: PackedPush[], options: GridRunOptions): Promise<GridOutcome> {
        for (let attempt = 0; attempt <= (job.retries ?? 0); attempt += 1) {
            const placed = await this.place(job, options.signal);

            if (!placed) {
                return ended(job, "stopped", "stopped before it started");
            }

            if (placed === "spent") {
                return ended(job, "failed", `no ${job.tag} node comes for it`);
            }

            await tryit(async () => {
                return options.onPlaced?.({ node: placed.link.address, job: placed.nodeJob });
            })();

            const [problem, outcome] = await tryit(() => {
                return runAttempt(placed.link, placed.nodeJob, job, packed, options);
            })();

            if (!problem) {
                return outcome;
            }

            if (problem instanceof GridHalted) {
                return ended(job, "stopped", "killed", placed.link.address);
            }

            /* A node that no longer has the job is as good as lost for it. */
            const isGone =
                problem instanceof GridLost || (problem instanceof GridReject && problem.reason === "unknown");

            if (!isGone) {
                return ended(job, "failed", problem.message, placed.link.address);
            }
        }

        return ended(job, "failed", "node lost; no retries left");
    }

    /* A job this hub opened before it restarted: stopped if it still runs (a kill, so a graceful stop), what it
       wrote pulled, then dropped, so its slot is free. False when the node no longer has it. */
    async recover(node: string, job: string, pulls: GridPull[]): Promise<boolean> {
        const link = this.links.find(({ address }) => {
            return address === node;
        });

        if (!link) {
            return false;
        }

        const [problem] = await tryit(async () => {
            const connection = await link.connect();
            const [killError] = await tryit(() => {
                return connection.request("kill", { job });
            })();

            /* A job that no longer runs refuses the kill; one the node no longer has cannot be recovered. */
            if (killError && (!(killError instanceof GridReject) || killError.reason === "unknown")) {
                throw killError;
            }

            for (let waited = 0; waited < RECOVER_WAIT_MS; waited += 1000) {
                const stat = await connection.request("stat", { job });
                if (stat.state !== "running") {
                    break;
                }

                await sleep(1000);
            }

            const folder = await mkdtemp(path.join(tmpdir(), "grid-recover-"));

            for (const [index, each] of pulls.entries()) {
                await mkdir(each.into, { recursive: true });

                await pullTar(connection, {
                    job,
                    path: each.path,
                    part: path.join(folder, `pull-${index}.part`),
                    into: each.into,
                });
            }

            await rm(folder, { recursive: true, force: true });
            await connection.request("drop", { job });
        })();

        if (problem) {
            this.log(`job ${job} on ${node} not recovered: ${problem.message}`);
        }

        return !problem;
    }

    close() {
        for (const link of this.links) {
            link.close();
        }
    }
}
