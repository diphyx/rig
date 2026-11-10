import { dialGrid } from "./wire.js";

import type { Keypair } from "./noise.js";
import type { GridConnection } from "./wire.js";

const LOST_AFTER_MS = 30_000;

/* With signal: lost after 15 s without a beat (grid spec §6: beats come every 5 s). */
const BEAT_LOST_AFTER_MS = 15_000;

function messageOf(problem: unknown): string {
    return problem instanceof Error ? problem.message : "no answer";
}

/** Where the hub's lines go: a node that stops answering, and answers again; a job that ends or waits. */
export type Log = (line: string) => void;

export interface GridNodeEntry {
    /** The rig machine's name. */
    name: string;
    tags: string[];
    ip: string;
    port: number;
    trust: Buffer;
    /* Its share is on, as the config hints: tried first for a job with a share push. */
    share: boolean;
}

/* One node from the config: its one shared connection, and whether it still answers. */
export class NodeLink {
    private connection: GridConnection | null = null;
    private connecting: Promise<GridConnection> | null = null;
    private failingSince: number | null = null;
    /* The config's hint, then what the node says in its push replies. */
    isSharing: boolean;

    /* With signal, the last beat; a node that has never beat is judged by its calls. */
    private lastBeat: number | null = null;

    /* Dropped: it dials no more, and a job on it counts it as lost. */
    private isClosed = false;

    constructor(
        public entry: GridNodeEntry,
        private readonly local: Keypair,
        private readonly log: Log,
    ) {
        this.isSharing = entry.share;
    }

    get address(): string {
        return `${this.entry.ip}:${this.entry.port}`;
    }

    /* Lost: calls failing for 30 s (spec §6, the hub decides; without signal there is no beat to miss). */
    get isLost(): boolean {
        if (this.isClosed) {
            return true;
        }

        if (this.lastBeat !== null) {
            return Date.now() - this.lastBeat > BEAT_LOST_AFTER_MS;
        }

        return this.failingSince !== null && Date.now() - this.failingSince > LOST_AFTER_MS;
    }

    /** It has beat, with signal. */
    get isBeating(): boolean {
        return this.lastBeat !== null;
    }

    /** A beat from the node, with signal: it is alive. */
    beat() {
        this.lastBeat = Date.now();
        this.seen();
    }

    serves(tag: string): boolean {
        return this.entry.tags.includes(tag);
    }

    shares(isOn: boolean) {
        this.isSharing = isOn;
    }

    /* A node that failed and answers again says so, once. */
    seen() {
        if (this.failingSince !== null) {
            this.log(`node ${this.address} answers again`);
        }

        this.failingSince = null;
    }

    /* The first failed call says why; the rest of the spell stays quiet. */
    failed(problem: unknown) {
        if (this.failingSince !== null) {
            return;
        }

        this.log(`node ${this.address} does not answer: ${messageOf(problem)}`);
        this.failingSince = Date.now();
    }

    /** The same machine, with a new IP, key or tags: a call after it dials the new one. */
    update(entry: GridNodeEntry) {
        const isMoved =
            entry.ip !== this.entry.ip || entry.port !== this.entry.port || !entry.trust.equals(this.entry.trust);

        this.entry = entry;

        if (isMoved) {
            this.connection?.close();
            this.connection = null;
        }
    }

    async connect(): Promise<GridConnection> {
        if (this.isClosed) {
            throw new Error(`grid: node ${this.address} was dropped`);
        }

        if (this.connection?.isOpen) {
            return this.connection;
        }

        this.connecting ??= dialGrid({
            ip: this.entry.ip,
            port: this.entry.port,
            local: this.local,
            remote: this.entry.trust,
        })
            .then((connection) => {
                this.connection = connection;
                this.seen();

                connection.onClose(() => {
                    if (this.connection === connection) {
                        this.connection = null;
                    }
                });

                return connection;
            })
            .catch((problem) => {
                this.failed(problem);

                throw problem;
            })
            .finally(() => {
                this.connecting = null;
            });

        return this.connecting;
    }

    close() {
        this.isClosed = true;
        this.connection?.close();
        this.connection = null;
    }
}
