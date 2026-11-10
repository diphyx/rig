import { rm } from "node:fs/promises";

import { shareProblem } from "./share.js";

import type {
    Attempt,
    GridEvent,
    GridOutcome,
    GridPull,
    GridPush,
    GridPushed,
    GridStep,
    GridStepResult,
} from "./job.js";

import type { Live } from "./book.js";
import type { TarStore } from "./tars.js";
import type { PulledFile } from "./transfer.js";

/** What `grid.session` takes: the job's tag and name, and what `run`'s options give. */
export type GridSessionOptions = {
    tag: string;
    /** The app's own name for it, unique among the hub's live jobs; by default `job-<8 hex>`. */
    name?: string;
    /** Its pushes have a share: a node with its share on is tried first. */
    share?: boolean;
    /** Stops it: while it waits for a node, or the step it runs. */
    signal?: AbortSignal;
    /** Its node's events, its log lines too, from its first. */
    watch?: (event: GridEvent) => void;
    /** Where it runs, once a node takes it: what `grid.recover` needs after a restart. */
    placed?: (placed: { node: string; job: string }) => void | Promise<void>;
};

/** A job on one node, its calls the app's, one at a time: push, exec, pull, then close. No retries: a lost node fails the call. */
export class GridSession {
    /** Its steps so far, each as it ended. */
    readonly steps: GridStepResult[] = [];
    /** Its pushes so far, and how each got there. */
    readonly pushed: GridPushed[] = [];
    /** What its pulls brought back so far. */
    readonly files: PulledFile[] = [];

    private readonly pushes: GridPush[] = [];
    private readonly pulls: GridPull[] = [];
    private isClosed = false;
    private closing: Promise<GridOutcome> | null = null;
    /* Calls run one after another, as a job's steps do. */
    private running: Promise<unknown> = Promise.resolve();

    constructor(
        private readonly attempt: Attempt,
        private readonly tars: TarStore,
        private readonly one: Live,
        private readonly folder: string,
        /** Its node's machine name. */
        readonly node: string,
        /* The hub's: the job ends, with its outcome. */
        private readonly onClose: (outcome: GridOutcome) => void,
    ) {}

    /** The job's name. */
    get name(): string {
        return this.one.view.name;
    }

    /* A kill, by its signal or `grid.kill`: its step stops; only pulls and close are left. */
    private get isKilled(): boolean {
        return this.one.abort.signal.aborted;
    }

    private call<T>(run: () => Promise<T>, isAfterKill = false): Promise<T> {
        if (this.isClosed) {
            return Promise.reject(new Error(`grid: job ${this.name} is closed`));
        }

        if (this.isKilled && !isAfterKill) {
            return Promise.reject(new Error(`grid: job ${this.name} was killed: pull what it kept, then close`));
        }

        const result = this.running.then(run);

        this.running = result.catch(() => {
            return null;
        });

        return result;
    }

    /* A share needs its own place in the space, as in a job (grid spec §10): checked with every push and pull so far. */
    private checkShares(push: GridPush[], pull: GridPull[]) {
        const problem = shareProblem({ tag: this.one.view.tag, steps: [], push, pull });

        if (problem) {
            throw new Error(`grid: ${problem}`);
        }
    }

    /** Files into the job's space, or a share kept on the node. */
    push(push: GridPush): Promise<GridPushed> {
        return this.call(async () => {
            this.checkShares([...this.pushes, push], this.pulls);

            const packed = await this.tars.pack(push.from);

            try {
                const pushed = await this.attempt.pushOne(push, packed);

                this.pushes.push(push);
                this.pushed.push(pushed);

                return pushed;
            } finally {
                await this.tars.release([packed]);
            }
        });
    }

    /** One of the node's cmds, run to its end: done, failed, or stopped by a kill or its timeout. */
    exec(step: GridStep): Promise<GridStepResult> {
        return this.call(async () => {
            const ended = await this.attempt.step(step);
            const result = { cmd: step.cmd, state: ended.state, message: ended.message };

            this.steps.push(result);

            return result;
        });
    }

    /** Files from the job's space, into a folder; after a kill too, for what its steps kept. */
    pull(pull: GridPull): Promise<PulledFile[]> {
        return this.call(async () => {
            this.checkShares(this.pushes, [...this.pulls, pull]);

            /* After a kill, out of its signal's reach. */
            const files = await this.attempt.pull(pull, this.isKilled ? null : undefined);

            this.pulls.push(pull);
            this.files.push(...files);

            return files;
        }, true);
    }

    /** Ends the job, once its last call ends: the node drops it, its slot is free. Its outcome: stopped by a kill, failed by a step, else done. */
    close(): Promise<GridOutcome> {
        this.isClosed = true;

        this.closing ??= (async () => {
            await this.running;
            await this.attempt.drop();
            await rm(this.folder, { recursive: true, force: true });

            const outcome = this.outcome();

            this.onClose(outcome);

            return outcome;
        })();

        return this.closing;
    }

    private outcome(): GridOutcome {
        const base = {
            name: this.name,
            node: this.attempt.address,
            steps: [...this.steps],
            pushed: [...this.pushed],
            files: [...this.files],
        };

        if (this.isKilled) {
            return { ...base, state: "stopped", message: "killed" };
        }

        const index = this.steps.findIndex((step) => {
            return step.state !== "done";
        });

        if (index === -1) {
            return { ...base, state: "done", message: "" };
        }

        const { cmd, state, message } = this.steps[index]!;
        const reason = message ? `: ${message}` : "";

        return { ...base, state: "failed", message: `step ${index + 1} (${cmd}): ${state}${reason}` };
    }
}
