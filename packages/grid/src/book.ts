import { randomBytes } from "node:crypto";

import { stateOf } from "./job.js";

import type { GridEvent, GridOutcome } from "./job.js";

/** What the hub tells about its jobs, through `grid.on`. */
export enum JobEvent {
    /** A node took the job: it runs there. */
    PLACED = "job:placed",
    /** Its node was lost: the job waits for another, to run again from the start. */
    RETRIED = "job:retried",
    /** It ended: done, failed or stopped; it leaves `grid.jobs()`. */
    ENDED = "job:ended",
}

/** A job of this hub, waiting or running. */
export type GridJobView = {
    /** The app's name for it, or one the hub made: `job-<8 hex>`. */
    name: string;
    tag: string;
    /** Waiting for a node with room, or running on one. */
    state: "waiting" | "running";
    /** Its node's machine name, once a node takes it. */
    node?: string;
    /** The cmd it runs now. */
    step?: string;
    /** How many nodes have taken it: `1` on its first. */
    tries: number;
    /** When it began, in unix ms. */
    started: number;
    /** Opened with `grid.session`: its calls are the app's, one by one. */
    session: boolean;
};

/** Which jobs `grid.jobs` gives: those with every key given. */
export type GridJobFilter = { tag?: string; state?: GridJobView["state"]; node?: string };

/** Each `grid.on` event's data. */
export type JobEvents = {
    [JobEvent.PLACED]: { job: GridJobView };
    [JobEvent.RETRIED]: { job: GridJobView; lost: string };
    [JobEvent.ENDED]: { job: GridJobView; outcome?: GridOutcome };
};

type Handler<E extends JobEvent> = (data: JobEvents[E]) => void;

/** One live job: what the app sees of it, what stops it, and who watches its events. */
export type Live = {
    view: GridJobView;
    abort: AbortController;
    watchers: Set<(event: GridEvent) => void>;
};

/* A copy, so the app cannot change the hub's own. */
function copyOf(view: GridJobView): GridJobView {
    return { ...view };
}

/** The hub's jobs, in memory: each from its start to its end. */
export class JobBook {
    private readonly live = new Map<string, Live>();
    private readonly handlers = new Map<JobEvent, Set<Handler<JobEvent>>>();

    /** A job begins: null when its name is taken by a live one. */
    start(name: string | undefined, tag: string, session: boolean): Live | null {
        const named = name ?? `job-${randomBytes(4).toString("hex")}`;

        if (this.live.has(named)) {
            return null;
        }

        const one: Live = {
            view: { name: named, tag, state: "waiting", tries: 0, started: Date.now(), session },
            abort: new AbortController(),
            watchers: new Set(),
        };

        this.live.set(named, one);

        return one;
    }

    placed(one: Live, node: string) {
        one.view.state = "running";
        one.view.node = node;
        one.view.tries += 1;
        this.emit(JobEvent.PLACED, { job: copyOf(one.view) });
    }

    retried(one: Live, lost: string) {
        one.view.state = "waiting";
        delete one.view.node;
        delete one.view.step;
        this.emit(JobEvent.RETRIED, { job: copyOf(one.view), lost });
    }

    /** A node's event for the job: to its watchers; a step that runs is its `step`. */
    event(one: Live, event: GridEvent) {
        const state = stateOf(event);

        if (state?.state === "running") {
            one.view.step = state.cmd;
        }

        for (const watcher of one.watchers) {
            watcher(event);
        }
    }

    end(one: Live, outcome?: GridOutcome) {
        if (this.live.get(one.view.name) !== one) {
            return;
        }

        this.live.delete(one.view.name);
        this.emit(JobEvent.ENDED, { job: copyOf(one.view), ...(outcome && { outcome }) });
    }

    list(filter: GridJobFilter = {}): GridJobView[] {
        return [...this.live.values()]
            .map((one) => {
                return one.view;
            })
            .filter((view) => {
                return (
                    (filter.tag === undefined || view.tag === filter.tag) &&
                    (filter.state === undefined || view.state === filter.state) &&
                    (filter.node === undefined || view.node === filter.node)
                );
            })
            .map(copyOf);
    }

    get(name: string): GridJobView | null {
        const one = this.live.get(name);

        return one ? copyOf(one.view) : null;
    }

    /** Stops a live job: false when none has the name. */
    kill(name: string): boolean {
        const one = this.live.get(name);

        one?.abort.abort();

        return Boolean(one);
    }

    /** Its node's events from now on, until the job ends or the call it gives is called. */
    watch(name: string, watcher: (event: GridEvent) => void): () => void {
        const one = this.live.get(name);

        if (!one) {
            throw new Error(`grid: no job ${name}`);
        }

        one.watchers.add(watcher);

        return () => {
            one.watchers.delete(watcher);
        };
    }

    on<E extends JobEvent>(event: E, handler: Handler<E>) {
        const set = this.handlers.get(event) ?? new Set();

        set.add(handler as Handler<JobEvent>);
        this.handlers.set(event, set);
    }

    /* A handler that throws does not stop the job, nor the other handlers. */
    private emit<E extends JobEvent>(event: E, data: JobEvents[E]) {
        for (const handler of this.handlers.get(event) ?? []) {
            try {
                (handler as Handler<E>)(data);
            } catch {
                /* the app's own */
            }
        }
    }
}
