import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isNumber, isObject, isString, sleep, tryit } from "radash";

import { spacePath } from "./share.js";
import { GridHalted, GridMismatch, GridUnpacked, pullTar, pushTar } from "./transfer.js";
import { GridReject } from "./wire.js";

import type { NodeLink } from "./nodes.js";
import type { PackedPush } from "./tars.js";
import type { PulledFile, PushHow } from "./transfer.js";
import type { CborValue } from "./cbor.js";
import type { GridCall, GridConnection } from "./wire.js";

const RETRY_EVERY_MS = 2000;
const CALL_RETRY_MS = 1000;
const KILL_WAIT_MS = 15_000;

/* How many times a push is sent while the node gives another sha256. */
const PUSH_TRIES = 3;

export type StepState = "idle" | "running" | "done" | "failed" | "stopped";

export interface GridStep {
    cmd: string;
    args?: string[];
    env?: Record<string, string>;
}

export interface GridPush {
    from: string;
    to?: string;
    /* A share push (spec §10): kept on the node for the jobs after, linked read only at `to`. */
    share?: boolean;
}

export interface GridPull {
    path: string;
    into: string;
    /* Only what the steps wrote: files changed since the first step ran. */
    fresh?: boolean;
    /* Pulled after a kill too, once the steps have stopped: what a stopped step wrote to resume from. */
    keep?: boolean;
}

export interface GridJob {
    /* The app's own name for it, unique among the hub's live jobs: what `grid.job`, `kill` and `watch` take. */
    name?: string;
    tag: string;
    push?: GridPush[];
    steps: GridStep[];
    pull?: GridPull[];
    retries?: number;
}

export interface GridEvent {
    seq: number;
    time: number;
    type: string;
    data: CborValue;
}

export interface GridStepResult {
    cmd: string;
    state: StepState;
    message: string;
}

export interface GridPushed {
    to: string;
    how: PushHow;
}

export interface GridOutcome {
    /* The job's name: the app's, or the one the hub made. */
    name: string;
    state: "done" | "failed" | "stopped";
    message: string;
    node: string | null;
    steps: GridStepResult[];
    pushed: GridPushed[];
    files: PulledFile[];
}

/* The job on its node, for `next`: what the steps wrote so far, pulled while the job goes on. */
export interface GridJobFiles {
    pull(pull: GridPull): Promise<PulledFile[]>;
}

export interface GridRunOptions {
    signal?: AbortSignal;
    watch?: (event: GridEvent) => void;
    /* After a step that ends done: it may pull from the job, and the steps it returns run next, in the same job. */
    next?: (step: GridStepResult, files: GridJobFiles) => Promise<GridStep[] | void>;
    /* Where the job runs, once a node takes it: what `GridHub.recover` needs after a restart. */
    placed?: (placed: { node: string; job: string }) => void | Promise<void>;
}

/* A job that cannot go on here, like a cmd the node does not have: no retry fixes it. */
class GridFailure extends Error {}

export class GridLost extends Error {
    constructor(address: string) {
        super(`node ${address} lost`);
    }
}

export interface StateEvent {
    state: StepState;
    cmd: string;
    message: string;
    time: number;
}

export function stateOf(event: GridEvent): StateEvent | null {
    if (event.type !== "state" || !isObject(event.data)) {
        return null;
    }

    const data = event.data as Record<string, CborValue>;

    return {
        state: data.state as StepState,
        cmd: isString(data.cmd) ? data.cmd : "",
        message: isString(data.message) ? data.message : "",
        time: event.time,
    };
}

/* Runs a call on the node's shared connection; a dropped connection is retried until the node counts as lost. */
async function onNode<T>(link: NodeLink, run: (connection: GridConnection) => Promise<T>): Promise<T> {
    while (true) {
        const [problem, result] = await tryit(async () => {
            return run(await link.connect());
        })();

        if (!problem) {
            link.seen();

            return result;
        }

        const isFinal =
            problem instanceof GridReject ||
            problem instanceof GridHalted ||
            problem instanceof GridFailure ||
            problem instanceof GridUnpacked ||
            problem instanceof GridMismatch;

        if (isFinal) {
            throw problem;
        }

        link.failed(problem);

        if (link.isLost) {
            throw new GridLost(link.address);
        }

        await sleep(CALL_RETRY_MS);
    }
}

/* Follows the job's events (spec §8): one tail, picked up again after the last seq when the connection drops. */
class Follower {
    private lastSeq = 0;
    private call: GridCall | null = null;
    private isClosed = false;
    private problem: Error | null = null;
    private readonly waiters = new Set<() => void>();
    readonly states: StateEvent[] = [];

    constructor(
        private readonly link: NodeLink,
        private readonly job: string,
        private readonly watch?: (event: GridEvent) => void,
    ) {
        void this.run();
    }

    private async run() {
        while (!this.isClosed) {
            const [problem] = await tryit(() => {
                return onNode(this.link, (connection) => {
                    return this.tail(connection);
                });
            })();

            if (problem instanceof GridLost || problem instanceof GridReject) {
                this.problem = problem;
                this.wake();

                return;
            }
        }
    }

    private async tail(connection: GridConnection) {
        this.call = await connection.start("tail", { job: this.job, ...(this.lastSeq ? { after: this.lastSeq } : {}) });
        await this.call.reply();

        while (!this.isClosed) {
            const [problem, envelope] = await tryit(() => {
                return this.call!.next();
            })();

            /* Closing the follower closes its call: that ends the tail, it is no dropped connection. */
            if (this.isClosed) {
                return;
            }

            if (problem) {
                throw problem;
            }

            if (envelope.end || envelope.reject) {
                return;
            }

            this.take(envelope.data as unknown as GridEvent);
        }
    }

    take(event: GridEvent) {
        if (!isObject(event) || !isNumber(event.seq) || event.seq <= this.lastSeq) {
            return;
        }

        this.lastSeq = event.seq;
        this.watch?.(event);

        const state = stateOf(event);

        if (state) {
            this.states.push(state);
            this.wake();
        }
    }

    private wake() {
        for (const waiter of this.waiters) {
            waiter();
        }
    }

    async nextState(timeout?: number): Promise<StateEvent | null> {
        const started = Date.now();

        while (!this.states.length) {
            if (this.problem) {
                throw this.problem;
            }

            if (timeout !== undefined && Date.now() - started > timeout) {
                return null;
            }

            await new Promise<void>((resolve) => {
                const done = () => {
                    clearTimeout(timer);
                    this.waiters.delete(done);
                    resolve();
                };

                const timer = setTimeout(done, 1000);
                this.waiters.add(done);
            });
        }

        return this.states.shift()!;
    }

    close() {
        this.isClosed = true;

        void this.call?.cancel().catch(() => {
            return null;
        });

        this.call?.close();
    }
}

export class Attempt implements GridJobFiles {
    readonly steps: GridStepResult[];
    private readonly follower: Follower;
    /* The node's clock when the first step ran: a pull `since` it takes only what the steps wrote. */
    private startedAt: number | undefined;
    private pulls = 0;

    constructor(
        private readonly link: NodeLink,
        private readonly nodeJob: string,
        private readonly job: GridJob,
        private readonly options: GridRunOptions,
        private readonly folder: string,
    ) {
        this.steps = job.steps.map((step) => {
            return { cmd: step.cmd, state: "idle", message: "" };
        });

        this.follower = new Follower(link, nodeJob, options.watch);
    }

    /** Its node's address: `<ip>:<port>`. */
    get address(): string {
        return this.link.address;
    }

    private get isHalted(): boolean {
        return Boolean(this.options.signal?.aborted);
    }

    async push(packed: PackedPush[]): Promise<GridPushed[]> {
        const pushed: GridPushed[] = [];

        for (const [index, push] of (this.job.push ?? []).entries()) {
            pushed.push(await this.pushOne(push, packed[index]!));
        }

        return pushed;
    }

    /** One push, packed: into the job's space, or kept on the node as a share. */
    async pushOne(push: GridPush, packed: PackedPush): Promise<GridPushed> {
        const { file, sum } = packed;
        /* The push id: the tar's sha256, its first 16 bytes. */
        const id = push.share ? sum.slice(0, 32) : undefined;

        const how = await this.pushChecked(() => {
            return onNode(this.link, (connection) => {
                return pushTar(connection, {
                    job: this.nodeJob,
                    to: push.to,
                    file,
                    sum,
                    id,
                    signal: this.options.signal,
                });
            });
        });

        if (push.share) {
            this.link.shares(how !== "normal");
        }

        return { to: spacePath(push.to), how };
    }

    /* A push, checked by its sha256: sent again while the node gives another, up to `PUSH_TRIES`; then the job fails, saying so. */
    private async pushChecked(send: () => Promise<PushHow>, tries = 1): Promise<PushHow> {
        const [problem, how] = await tryit(send)();

        if (!problem) {
            return how;
        }

        if (!(problem instanceof GridMismatch)) {
            throw problem;
        }

        if (tries === PUSH_TRIES) {
            throw new GridFailure(`${problem.message}, ${PUSH_TRIES} times`);
        }

        return this.pushChecked(send, tries + 1);
    }

    /** One step: its cmd run, then its end; a kill stops it. */
    async step(step: GridStep): Promise<StateEvent> {
        await this.exec(step);

        return this.waitEnd(step);
    }

    private async exec(step: GridStep) {
        await onNode(this.link, async (connection) => {
            const body = {
                job: this.nodeJob,
                cmd: step.cmd,
                ...(step.args?.length ? { args: step.args } : {}),
                ...(step.env ? { env: step.env } : {}),
            };

            const [problem] = await tryit(() => {
                return connection.request("exec", body);
            })();

            /* A resend after a dropped connection: the first one got there, and that exec is this step. */
            if (problem instanceof GridReject && problem.reason === "running") {
                return;
            }

            /* `unknown` with the job still there means no such cmd: a failure, not a lost job to run again. */
            if (problem instanceof GridReject && problem.reason === "unknown" && (await this.hasJob(connection))) {
                throw new GridFailure(`no cmd ${step.cmd} on this node`);
            }

            if (problem) {
                throw problem;
            }
        });
    }

    private async hasJob(connection: GridConnection): Promise<boolean> {
        const [problem] = await tryit(() => {
            return connection.request("stat", { job: this.nodeJob });
        })();

        return !problem;
    }

    private async kill(cmd: string): Promise<StateEvent> {
        await tryit(() => {
            return onNode(this.link, (connection) => {
                return connection.request("kill", { job: this.nodeJob });
            });
        })();

        const deadline = Date.now() + KILL_WAIT_MS;

        while (Date.now() < deadline) {
            const state = await this.follower.nextState(deadline - Date.now());

            if (state?.cmd === cmd && state.state === "stopped") {
                return state;
            }
        }

        return { state: "stopped", cmd, message: "no answer to kill", time: Date.now() };
    }

    /* An end counts only after this step's own `running`. */
    private async waitEnd(step: GridStep): Promise<StateEvent> {
        let isStarted = false;

        while (true) {
            if (this.isHalted) {
                return this.kill(step.cmd);
            }

            const state = await this.follower.nextState(1000);

            if (!state) {
                continue;
            }

            if (state.cmd === step.cmd && state.state === "running") {
                isStarted = true;
                this.startedAt ??= state.time;
            }

            if (isStarted && state.state !== "running" && state.state !== "idle") {
                return state;
            }
        }
    }

    async run(): Promise<{ state: GridOutcome["state"]; message: string }> {
        const steps = [...this.job.steps];

        for (let index = 0; index < steps.length; index += 1) {
            const step = steps[index]!;
            this.steps[index]!.state = "running";

            const ended = await this.step(step);
            this.steps[index] = { cmd: step.cmd, state: ended.state, message: ended.message };

            if (this.isHalted) {
                return { state: "stopped", message: "killed" };
            }

            /* A job ends `stopped` only by kill; a step stopped otherwise (its timeout) fails it. */
            if (ended.state !== "done") {
                const reason = ended.message ? `: ${ended.message}` : "";

                return { state: "failed", message: `step ${index + 1} (${step.cmd}): ${ended.state}${reason}` };
            }

            const more = (await this.options.next?.(this.steps[index]!, this)) ?? [];
            steps.push(...more);

            this.steps.push(
                ...more.map((each) => {
                    return { cmd: each.cmd, state: "idle" as const, message: "" };
                }),
            );
        }

        return { state: "done", message: "" };
    }

    /* One pull into its folder, while the job goes on or after it ended; a null signal is out of the abort's reach. */
    async pull(each: GridPull, signal: AbortSignal | null = this.options.signal ?? null): Promise<PulledFile[]> {
        await mkdir(each.into, { recursive: true });
        this.pulls += 1;

        return onNode(this.link, (connection) => {
            return pullTar(connection, {
                job: this.nodeJob,
                path: each.path,
                part: path.join(this.folder, `pull-${this.pulls}.part`),
                into: each.into,
                since: each.fresh ? this.startedAt : undefined,
                signal: signal ?? undefined,
            });
        });
    }

    /* The job's pulls; after a kill only the kept ones, out of the abort's reach. */
    async pullAll(isStopped = false): Promise<PulledFile[]> {
        const pulled: PulledFile[] = [];

        for (const each of this.job.pull ?? []) {
            if (!isStopped || each.keep) {
                pulled.push(...(await this.pull(each, isStopped ? null : (this.options.signal ?? null))));
            }
        }

        return pulled;
    }

    async drop() {
        this.follower.close();

        await tryit(() => {
            return onNode(this.link, (connection) => {
                return connection.request("drop", { job: this.nodeJob });
            });
        })();
    }
}

export async function runAttempt(
    link: NodeLink,
    nodeJob: string,
    job: GridJob,
    packed: PackedPush[],
    options: GridRunOptions,
): Promise<GridOutcome> {
    const folder = await mkdtemp(path.join(tmpdir(), "grid-job-"));
    const attempt = new Attempt(link, nodeJob, job, options, folder);

    return (async (): Promise<GridOutcome> => {
        const pushed = await attempt.push(packed);
        const base = {
            name: job.name ?? "",
            node: link.address,
            steps: attempt.steps,
            pushed,
            files: [] as PulledFile[],
        };

        if (options.signal?.aborted) {
            return { ...base, state: "stopped", message: "killed" };
        }

        const result = await attempt.run();

        /* A stopped job is not run again: a kept pull that fails leaves it without files. */
        if (result.state === "stopped") {
            const [, files] = await tryit(() => {
                return attempt.pullAll(true);
            })();

            return { ...base, ...result, files: files ?? [] };
        }

        /* A failed step skips the rest, but the files are still pulled. */
        return { ...base, ...result, files: await attempt.pullAll() };
    })().finally(async () => {
        await attempt.drop();
        await rm(folder, { recursive: true, force: true });
    });
}

export { RETRY_EVERY_MS };
