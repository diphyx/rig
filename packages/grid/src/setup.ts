import { generateKeyPairSync } from "node:crypto";
import { isIP } from "node:net";

import type { KindWorker, Rule } from "@diphyx/rig";
import { isArray, isObject, isString } from "radash";

/* The grid generation this hub speaks. */
const GRID = 2;

/* A rig name: `[a-z][a-z0-9-]{0,31}`; grid's tags and cmd names are names too. */
const NAME = /^[a-z][a-z0-9-]{0,31}$/;

/* A dur: a number and one of s, m, h, d. */
const DUR = /^\d+(s|m|h|d)$/;

/* A size: a number and one of B, KB, MB, GB, TB, in binary. */
const SIZE = /^\d+(B|KB|MB|GB|TB)$/;

/** A kind's `worker`, as grid reads it: its tags, its cmds, `signal`, `jobs` and `share`. */
export type GridWorker = KindWorker & {
    /** The only cmds its node runs: grid's `[cmds.<name>]`. */
    cmds: Record<string, { exec: string[]; timeout?: string }>;
    /** grid's `signal`: the node also dials the hub, with heartbeats. */
    signal?: boolean;
    /** grid's `[jobs]`: `limit`, how many at once, `1`; `expires`, how long it keeps a job left idle. */
    jobs?: { limit?: number; expires?: string };
    /** grid's `[share]`: `limit`, how much of its share pushes it keeps; `expires`, how long it keeps one no job uses. */
    share?: { limit?: string; expires?: string };
};

/** What a node needs to know of its hub. */
export type HubSide = {
    ip: string;
    port: number;
    listen?: number;
    key: string;
    release: { version: string; sha256: { arm: string; x86: string } };
};

/** A machine's own grid key pair, X25519, each half raw and base64. */
export function makeGridKey(): { private: string; public: string } {
    const { privateKey, publicKey } = generateKeyPairSync("x25519");

    const raw = (jwk: string | undefined): string => {
        return Buffer.from(jwk ?? "", "base64url").toString("base64");
    };

    return { private: raw(privateKey.export({ format: "jwk" }).d), public: raw(publicKey.export({ format: "jwk" }).x) };
}

/** The rule that lets the hub dial a machine's node. */
export function hubRule(hub: HubSide): Rule {
    return { port: hub.port, from: `${hub.ip}/${isIP(hub.ip) === 6 ? 128 : 32}` };
}

/* A file's text: lines joined by `\n`, ending with one, as base64 on one line. */
function base64Of(lines: string[]): string {
    return Buffer.from(`${lines.join("\n")}\n`).toString("base64");
}

/* The node's config, grid's `node.toml`: its strings as JSON writes them; with signal, the hub's `listen` port; `jobs` and `share` only with a key. */
function tomlOf(worker: GridWorker, hub: HubSide): string[] {
    const text = (value: string): string => {
        return JSON.stringify(value);
    };

    const table = (name: string, keys: { limit?: number | string; expires?: string } = {}): string[] => {
        const lines = [
            ...(keys.limit !== undefined ? [`limit = ${isString(keys.limit) ? text(keys.limit) : keys.limit}`] : []),
            ...(keys.expires !== undefined ? [`expires = ${text(keys.expires)}`] : []),
        ];

        return lines.length > 0 ? ["", `[${name}]`, ...lines] : [];
    };

    return [
        `grid = ${GRID}`,
        'identity = "/etc/grid/node.key"',
        `tags = [${worker.tags.map(text).join(", ")}]`,
        `port = ${hub.port}`,
        ...(worker.signal ? ["signal = true"] : []),
        "",
        "[[hubs]]",
        `ip = ${text(hub.ip)}`,
        ...(worker.signal ? [`port = ${hub.listen}`] : []),
        'trust = "/etc/grid/hub.pub"',
        ...table("jobs", worker.jobs),
        ...table("share", worker.share),
        ...Object.entries(worker.cmds).flatMap(([name, cmd]) => {
            return [
                "",
                `[cmds.${name}]`,
                `exec = [${cmd.exec.map(text).join(", ")}]`,
                ...(cmd.timeout !== undefined ? [`timeout = ${text(cmd.timeout)}`] : []),
            ];
        }),
    ];
}

/* The node runs as its own user, `grid`, and comes back when it stops. */
const UNIT = [
    "[Unit]",
    "Description=grid node",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "User=grid",
    "ExecStart=/usr/local/bin/grid node run",
    "Restart=always",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
];

/* Enabled only after the kind's `script`: no job before what its cmds need, and none at all after a failed one. */
const START = ["systemctl enable --now grid-node"];

/** The first-boot lines that make a machine a grid node: grid installed, checked by its SHA-256, and set up; started after the kind's `script`. */
export function nodePart(worker: GridWorker, hub: HubSide, key: string): { script: string[]; start: string[] } {
    const { version, sha256 } = hub.release;

    const script = [
        'case "$(uname -m)" in',
        `    aarch64) arch=arm64; sha=${sha256.arm} ;;`,
        `    x86_64) arch=amd64; sha=${sha256.x86} ;;`,
        '    *) echo "rig: grid has no build for $(uname -m)" >&2; exit 1 ;;',
        "esac",
        "archive=$(mktemp)",
        `curl -fsSL --retry 5 --retry-connrefused "https://github.com/diphyx/grid/releases/download/v${version}/grid_${version}_linux_\${arch}.tar.gz" -o "$archive"`,
        'echo "$sha  $archive" | sha256sum -c -',
        `tar -xzf "$archive" -C /usr/local/bin --strip-components=1 --no-same-owner "grid_${version}_linux_\${arch}/grid"`,
        'rm "$archive"',
        "chown root:root /usr/local/bin/grid",
        "chmod 755 /usr/local/bin/grid",
        "id -u grid >/dev/null 2>&1 || useradd --system --home-dir /var/lib/grid --create-home --shell /usr/sbin/nologin grid",
        "mkdir -p /etc/grid",
        "chown root:grid /etc/grid",
        "chmod 750 /etc/grid",
        `echo '${key}' > /etc/grid/node.key`,
        "chown grid:grid /etc/grid/node.key",
        "chmod 600 /etc/grid/node.key",
        `echo '${hub.key}' > /etc/grid/hub.pub`,
        `echo '${base64Of(tomlOf(worker, hub))}' | base64 -d > /etc/grid/node.toml`,
        `echo '${base64Of(UNIT)}' | base64 -d > /etc/systemd/system/grid-node.service`,
        "systemctl daemon-reload",
    ];

    return { script, start: START };
}

/** A kind's `worker`, as grid reads it: its cmds, `signal` only with a hub that listens, `jobs` and `share`. */
export function checkWorker(worker: KindWorker, listen: number | undefined): void {
    for (const key of Object.keys(worker)) {
        if (!["name", "tags", "cmds", "signal", "jobs", "share"].includes(key)) {
            throw new Error(`${key} is not a key of grid's worker`);
        }
    }

    const { cmds, signal, jobs, share } = worker as Partial<GridWorker>;

    if (!isObject(cmds) || Object.keys(cmds).length === 0) {
        throw new Error("cmds: at least one cmd");
    }

    for (const [name, cmd] of Object.entries(cmds)) {
        if (!NAME.test(name) || !isObject(cmd)) {
            throw new Error(`cmds.${name}: a cmd, under a name`);
        }

        for (const key of Object.keys(cmd)) {
            if (!["exec", "timeout"].includes(key)) {
                throw new Error(`cmds.${name}.${key}: not a key of a cmd`);
            }
        }

        if (
            !isArray(cmd.exec) ||
            cmd.exec.length === 0 ||
            !cmd.exec.every((arg) => {
                return isString(arg);
            })
        ) {
            throw new Error(`cmds.${name}.exec: a command line, at least one str`);
        }

        if (cmd.timeout !== undefined && (!isString(cmd.timeout) || !DUR.test(cmd.timeout))) {
            throw new Error(`cmds.${name}.timeout: not a dur`);
        }
    }

    if (signal !== undefined && signal !== true && signal !== false) {
        throw new Error("signal: not a bool");
    }

    if (signal && listen === undefined) {
        throw new Error("signal: needs a hub with listen");
    }

    /* grid's `[jobs]` and `[share]`: each a `limit` and an `expires`. */
    for (const [name, table] of Object.entries({ jobs, share })) {
        if (table === undefined) {
            continue;
        }

        if (!isObject(table)) {
            throw new Error(`${name}: not an object`);
        }

        for (const key of Object.keys(table)) {
            if (!["limit", "expires"].includes(key)) {
                throw new Error(`${name}.${key}: not a key of ${name}`);
            }
        }

        if (table.expires !== undefined && (!isString(table.expires) || !DUR.test(table.expires))) {
            throw new Error(`${name}.expires: not a dur`);
        }
    }

    if (jobs?.limit !== undefined && (!Number.isSafeInteger(jobs.limit) || jobs.limit < 1)) {
        throw new Error("jobs.limit: a uint, from 1");
    }

    if (share?.limit !== undefined && (!isString(share.limit) || !SIZE.test(share.limit))) {
        throw new Error('share.limit: not a size, like "10GB"');
    }
}
