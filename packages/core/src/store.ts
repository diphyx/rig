import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Reason } from "./enums.js";
import { Refusal } from "./refusal.js";
import type { Machine, Place, Seen } from "./types.js";

/** A machine the core knows, with the replacements made along its chain. */
export type Known = Machine & { chain: number };

/** A lost machine still waiting for a recover. */
export type Pending = { lost: Machine; chain: number };

type Machines = { machines: Known[]; pending: Pending[] };

const COUNTS = ["tries", "busy", "created", "lost", "hours"] as const;

/** A place's key in `risk.json`: `<provider>/<market>/<type>/<zone>`. */
export function placeKey(provider: string, place: Place): string {
    return `${provider}/${place.market}/${place.type}/${place.zone}`;
}

function read<T>(file: string, empty: T): T {
    try {
        return JSON.parse(readFileSync(file, "utf8")) as T;
    } catch {
        return empty;
    }
}

/* Written whole, then moved in place, so a file is always whole. */
function write(file: string, value: unknown): void {
    writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 4)}\n`);
    renameSync(`${file}.tmp`, file);
}

/** What the core knows, under `<store>/rig/1/`. */
export class Store {
    readonly folder: string;
    machines: Known[] = [];
    pending: Pending[] = [];
    risk: Record<string, Seen> = {};

    constructor(store: string) {
        this.folder = join(store, "rig", "1");
    }

    load(): void {
        const machines = read<Machines>(join(this.folder, "machines.json"), { machines: [], pending: [] });

        this.machines = machines.machines;
        this.pending = machines.pending;
        this.risk = read(join(this.folder, "risk.json"), {});
    }

    save(): void {
        mkdirSync(this.folder, { recursive: true });
        write(join(this.folder, "machines.json"), { machines: this.machines, pending: this.pending });
        write(join(this.folder, "risk.json"), this.risk);
    }

    /** A known machine by id, or `unknown`. */
    known(id: string): Known {
        const known = this.machines.find((machine) => {
            return machine.id === id;
        });

        if (!known) {
            throw new Refusal(Reason.UNKNOWN, `no machine ${id}`);
        }

        return known;
    }

    forget(known: Known): void {
        this.machines = this.machines.filter((machine) => {
            return machine !== known;
        });
    }

    /** The core's own count for a place, made on first use; the same object every time. */
    seen(key: string): Seen {
        const seen = (this.risk[key] ??= { tries: 0, busy: 0, created: 0, lost: 0, hours: 0 });

        for (const count of COUNTS) {
            seen[count] ??= 0;
        }

        return seen;
    }
}
