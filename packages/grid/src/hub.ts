import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isString, sleep, tryit } from "radash";

import { Attempt, GridLost, RETRY_EVERY_MS, runAttempt } from "./job.js";
import { NodeLink } from "./nodes.js";
import { GridSession } from "./session.js";
import { shareProblem } from "./share.js";
import { TarStore } from "./tars.js";
import { GridHalted, pullTar } from "./transfer.js";
import { GridReject } from "./wire.js";

import type { GridJob, GridOutcome, GridPull, GridRunOptions } from "./job.js";
import type { JobBook, Live } from "./book.js";
import type { GridSessionOptions } from "./session.js";
import type { GridNode, GridNodeEntry, GridNodeFilter, Log } from "./nodes.js";
import type { Keypair } from "./noise.js";
import type { PackedPush } from "./tars.js";

const RECOVER_WAIT_MS = 15_000;

const noLog: Log = () => {};

function nameOf(job: GridJob): string {
    return `${job.name ?? "job"} (${job.steps
        .map((step) => {
            return step.cmd;
        })
        .join(", ")})`;
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

    return { name: job.name ?? "", state, message, node, steps, pushed: [], files: [] };
}

/** The hub side of grid/2: it knows the nodes, places each job on one with its tag, and runs it there. */
export class GridHub {
    readonly links: NodeLink[] = [];
    /** Its live jobs: waiting, running, or in a session; the grid's own, so it is heard before the hub opens. */
    readonly book: JobBook;
    private readonly tars: TarStore;
    private readonly log: Log;
    /* Tags no more nodes come for: a job waiting for one of them fails. */
    private readonly spentTags = new Set<string>();

    constructor(
        private readonly local: Keypair,
        options: { book: JobBook; tars?: string; log?: Log },
    ) {
        this.book = options.book;
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

    /** Its nodes, those with every key the filter gives, each with the jobs it runs now. */
    nodes(filter: GridNodeFilter = {}): GridNode[] {
        const jobs = this.book.list();

        return this.links
            .map((link) => {
                const { name, ip, tags } = link.entry;

                const on = jobs
                    .filter((job) => {
                        return job.node === name;
                    })
                    .map((job) => {
                        return job.name;
                    });

                return { name, ip, tags: [...tags], beating: link.isBeating, lost: link.isLost, jobs: on };
            })
            .filter((node) => {
                return (
                    (filter.tag === undefined || node.tags.includes(filter.tag)) &&
                    (filter.beating === undefined || node.beating === filter.beating) &&
                    (filter.lost === undefined || node.lost === filter.lost)
                );
            });
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
    private async place(tag: string, isSharing: boolean, label: string, signal: AbortSignal | undefined) {
        let isWaitNoted = false;

        while (!signal?.aborted) {
            let isFull = false;

            /* No node has the tag, and none comes for it (rig spec §22.1, `spent`). */
            if (this.spentTags.has(tag) && this.candidates(tag, isSharing).length === 0) {
                return "spent" as const;
            }

            for (const link of this.candidates(tag, isSharing)) {
                const [problem, opened] = await tryit(async () => {
                    return (await link.connect()).request("open", { tag });
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
                this.log(`${label} waits: no ${tag} node has room`);
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

    /* A job begins in the book, by its name: a problem when the name is not one, or taken. */
    private begin(
        name: string | undefined,
        tag: string,
        session: boolean,
        given: AbortSignal | undefined,
    ): { one: Live; signal: AbortSignal } | string {
        if (name !== undefined && (!isString(name) || name === "")) {
            return "name: not a str";
        }

        const one = this.book.start(name, tag, session);

        if (!one) {
            return `a job ${name} runs already`;
        }

        /* Its own signal, or a kill by its name. */
        return { one, signal: given ? AbortSignal.any([given, one.abort.signal]) : one.abort.signal };
    }

    async run(given: GridJob, options: GridRunOptions = {}): Promise<GridOutcome> {
        const begun = this.begin(given.name, given.tag, false, options.signal);

        if (isString(begun)) {
            return ended(given, "failed", begun);
        }

        const { one, signal } = begun;
        const job = { ...given, name: one.view.name };
        const started = Date.now();

        const outcome = await this.runJob(job, one, {
            ...options,
            signal,
            watch: (event) => {
                options.watch?.(event);
                this.book.event(one, event);
            },
        });

        this.book.end(one, outcome);
        report(job, outcome, started, this.log);

        return outcome;
    }

    /** A job on one node, its calls the app's: it waits for a node with the tag, as a job does. */
    async session(given: GridSessionOptions): Promise<GridSession> {
        const begun = this.begin(given.name, given.tag, true, given.signal);

        if (isString(begun)) {
            throw new Error(`grid: ${begun}`);
        }

        const { one, signal } = begun;
        const placed = await this.place(given.tag, Boolean(given.share), one.view.name, signal);

        if (!placed || placed === "spent") {
            this.book.end(one);

            throw new Error(
                placed ? `grid: no ${given.tag} node comes for ${one.view.name}` : "grid: stopped before it started",
            );
        }

        this.book.placed(one, placed.link.entry.name);

        await tryit(async () => {
            return given.placed?.({ node: placed.link.address, job: placed.nodeJob });
        })();

        const job: GridJob = { name: one.view.name, tag: given.tag, steps: [] };
        const started = Date.now();
        const folder = await mkdtemp(path.join(tmpdir(), "grid-job-"));

        const attempt = new Attempt(
            placed.link,
            placed.nodeJob,
            job,
            {
                signal,
                watch: (event) => {
                    given.watch?.(event);
                    this.book.event(one, event);
                },
            },
            folder,
        );

        return new GridSession(attempt, this.tars, one, folder, placed.link.entry.name, (outcome) => {
            this.book.end(one, outcome);
            report({ ...job, steps: outcome.steps }, outcome, started, this.log);
        });
    }

    private async runJob(job: GridJob, one: Live, options: GridRunOptions): Promise<GridOutcome> {
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

        return this.attempts(job, one, packed, options).finally(() => {
            return this.tars.release(packed);
        });
    }

    /* Each attempt on a node that takes the job; a lost node runs it again from the start elsewhere. */
    private async attempts(
        job: GridJob,
        one: Live,
        packed: PackedPush[],
        options: GridRunOptions,
    ): Promise<GridOutcome> {
        const isSharing = Boolean(
            job.push?.some((push) => {
                return push.share;
            }),
        );

        for (let attempt = 0; attempt <= (job.retries ?? 0); attempt += 1) {
            const placed = await this.place(job.tag, isSharing, nameOf(job), options.signal);

            if (!placed) {
                return ended(job, "stopped", "stopped before it started");
            }

            if (placed === "spent") {
                return ended(job, "failed", `no ${job.tag} node comes for it`);
            }

            this.book.placed(one, placed.link.entry.name);

            await tryit(async () => {
                return options.placed?.({ node: placed.link.address, job: placed.nodeJob });
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

            if (attempt < (job.retries ?? 0)) {
                this.book.retried(one, placed.link.entry.name);
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
