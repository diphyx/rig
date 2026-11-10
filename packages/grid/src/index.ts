import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname } from "node:path";

import { Reason, Refusal, Slot, type Worker } from "@diphyx/rig";
import { tryit } from "radash";

import data from "./grid.json" with { type: "json" };
import { GridHub } from "./hub.js";
import type { GridJob, GridOutcome, GridPull, GridRunOptions } from "./job.js";
import { type Listener, listenGrid } from "./listen.js";
import type { Log } from "./nodes.js";
import { type Keypair, keypairOf } from "./noise.js";
import { checkWorker, type GridWorker, type HubSide, hubRule, makeGridKey, nodePart } from "./setup.js";
import { DEFAULT_PORT } from "./wire.js";

export type {
    GridEvent,
    GridJob,
    GridJobFiles,
    GridOutcome,
    GridPull,
    GridPush,
    GridPushed,
    GridRunOptions,
    GridStep,
    GridStepResult,
    StepState,
} from "./job.js";

export type { Log } from "./nodes.js";
export type { GridWorker } from "./setup.js";

/* A grid key: raw X25519, 32 bytes, base64. */
const KEY = /^[A-Za-z0-9+/]{43}=$/;

/* Where the hub's key is kept by default, in the app's folder; it is not the config's store. */
const IDENTITY = "./.rig/grid/hub.key";

/* Asked for the app host's public IP, when the config gives none. */
const PUBLIC_IP = "https://checkip.amazonaws.com";

/** The grid release its nodes install: a version, and each arch's archive's SHA-256. */
export type GridRelease = { version: string; sha256: { arm: string; x86: string } };

/** The grid release this package installs by default, with its archives' SHA-256. */
export const RELEASE: GridRelease = data.release;

/** The grid worker's config: every key has a default. */
export type GridConfig = {
    /** Its name in rig's `workers`; `"grid"`. */
    name?: string;
    /** The hub's IP, as the machines see it; found when rig opens: the app host's public IP, or its own with `reach: "private"`. */
    ip?: string;
    /** The hub's private key: a path to its file, or the key itself, base64; `./.rig/grid/hub.key`, made on first use. */
    identity?: string;
    /** The grid release its nodes install; this package's own, `RELEASE`. */
    release?: GridRelease;
    /** The port its nodes listen on; `9420`. */
    port?: number;
    /** The port it listens on for nodes with `signal`; absent, it listens on none, and takes no node with `signal`. */
    listen?: number;
    /** Which of a machine's IPs it dials, and which of its own it gives them; `"public"`. */
    reach?: "public" | "private";
    extra?: GridExtra;
};

/** The grid worker's own settings, under `extra`. */
export type GridExtra = {
    /** Where pushes are packed; the system's temp folder. */
    tars?: string;
    /** Where its lines go: a node that stops answering, a job that ends or waits; none by default. */
    log?: Log;
};

/** rig's worker plugin, and the app's calls on its jobs. */
export type Grid = Worker & {
    /** The hub's grid public key, what each node trusts; known once it opens. */
    readonly key: string;
    /** The hub's IP, as the machines see it; known once it opens. */
    readonly ip: string;
    /** Runs a job on a node with its tag; a lost node runs it again elsewhere, up to its `retries`. */
    run(job: GridJob, options?: GridRunOptions): Promise<GridOutcome>;
    /** A job this hub opened before a restart: stopped if it still runs, its files pulled, then dropped. */
    recover(node: string, job: string, pulls: GridPull[]): Promise<boolean>;
    /** Every node it has: its machine's name, IP and tags, whether it beats (signal), and whether it is lost. */
    nodes(): { name: string; ip: string; tags: string[]; beating: boolean; lost: boolean }[];
    /** Closes every connection, and stops listening. */
    close(): Promise<void>;
};

function refuse(message: string): never {
    throw new Refusal(Reason.CONFIG, `grid: ${message}`);
}

/* The hub's private key: a path to its file, made there on first use when it is the default; or the key itself. */
function keyOf(identity: string, isDefault: boolean): Buffer {
    /* A key is 44 base64 characters, ending in `=`: anything else is a path, even one made of base64's letters. */
    const decode = (text: string): Buffer | null => {
        return KEY.test(text.trim()) ? Buffer.from(text.trim(), "base64") : null;
    };

    if (isDefault && !existsSync(identity)) {
        mkdirSync(dirname(identity), { recursive: true, mode: 0o700 });
        writeFileSync(identity, `${makeGridKey().private}\n`, { mode: 0o600 });
    }

    const [problem, text] = tryit(() => {
        return readFileSync(identity, "utf8");
    })();

    const key = (problem ? null : decode(text)) ?? decode(identity);

    if (!key) {
        refuse("identity is not a key, or a file holding one");
    }

    return key;
}

/* The app host's own IP on its network: its first IPv4 that is not loopback. */
function privateIp(): string | undefined {
    return Object.values(networkInterfaces())
        .flat()
        .find((one) => {
            return one?.family === "IPv4" && !one.internal;
        })?.address;
}

/* The app host's public IP, as the internet sees it. */
async function publicIp(): Promise<string | undefined> {
    const [problem, answer] = await tryit(async () => {
        return fetch(PUBLIC_IP, { signal: AbortSignal.timeout(5000) });
    })();

    const ip = problem || !answer.ok ? undefined : (await answer.text()).trim();

    return ip && isIP(ip) ? ip : undefined;
}

/** rig spec §22: the grid worker: its hub runs in the app, dials the nodes on rig's machines, and runs jobs on them over grid/2. */
export function createGrid(config: GridConfig = {}): Grid {
    if (config.ip !== undefined && !isIP(config.ip)) {
        refuse("ip is not an IP");
    }

    const port = config.port ?? DEFAULT_PORT;
    const log: Log = config.extra?.log ?? (() => {});

    /* What it finds out when rig opens it: its key, its IP, and the hub itself. */
    let opened: { local: Keypair; side: HubSide; hub: GridHub } | null = null;
    let listening: Promise<Listener> | null = null;

    const ready = () => {
        if (!opened) {
            throw new Error("grid: not open yet: rig opens it, with rig.open()");
        }

        return opened;
    };

    return {
        slot: Slot.WORKER,
        name: config.name ?? "grid",
        rig: 1,

        get key() {
            return ready().side.key;
        },

        get ip() {
            return ready().side.ip;
        },

        /* Its key, made or read; its IP, given or found. */
        async open() {
            if (opened) {
                return;
            }

            const local = keypairOf(keyOf(config.identity ?? IDENTITY, config.identity === undefined));
            const ip = config.ip ?? (config.reach === "private" ? privateIp() : await publicIp());

            if (!ip) {
                refuse(`no ${config.reach ?? "public"} IP found for the hub: give it as ip`);
            }

            const side: HubSide = {
                ip,
                port,
                ...(config.listen !== undefined && { listen: config.listen }),
                key: local.public.toString("base64"),
                release: config.release ?? RELEASE,
            };

            const hub = new GridHub(local, { ...(config.extra?.tars && { tars: config.extra.tars }), log });

            opened = { local, side, hub };
        },

        check(worker) {
            checkWorker(worker, config.listen);
        },

        /* A machine's own grid key: the private half only in its first-boot lines, the public half its `key`. */
        setup(machine) {
            const { side } = ready();
            const key = makeGridKey();

            return {
                script: nodePart(machine.worker as GridWorker, side, key.private),
                ports: [hubRule(side)],
                key: key.public,
            };
        },

        async add(machine) {
            const { local, hub } = ready();

            /* The machine's IP this hub dials: its `reach`. */
            const ip = config.reach === "private" ? machine.ip.private : machine.ip.public;

            if (!ip) {
                throw new Error(`grid: ${machine.name} has no ${config.reach ?? "public"} IP yet`);
            }

            /* Listening first: a port that will not bind fails the add, and the next add tries again. */
            if (config.listen !== undefined) {
                listening ??= listenGrid({ port: config.listen, local, hub, log }).catch((problem: unknown) => {
                    listening = null;

                    throw problem;
                });

                await listening;
            }

            hub.add({
                name: machine.name,
                tags: machine.tags,
                ip,
                port,
                trust: Buffer.from(machine.key, "base64"),
                share: false,
            });
        },

        async drop(name) {
            ready().hub.drop(name);

            (
                await listening?.catch(() => {
                    return null;
                })
            )?.drop(name);
        },

        async spent(tags) {
            ready().hub.spent(tags);
        },

        run(job, options) {
            return ready().hub.run(job, options);
        },

        recover(node, job, pulls) {
            return ready().hub.recover(node, job, pulls);
        },

        nodes() {
            return (opened?.hub.links ?? []).map((link) => {
                const { name, ip, tags } = link.entry;

                return { name, ip, tags, beating: link.isBeating, lost: link.isLost };
            });
        },

        async close() {
            opened?.hub.close();

            await (
                await listening?.catch(() => {
                    return null;
                })
            )?.close();
        },
    };
}
