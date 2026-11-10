import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isIP } from "node:net";
import path from "node:path";

import { createRig, Market, type Provider, Slot } from "@diphyx/rig";
import { sleep } from "radash";
import { afterAll, describe, expect, it } from "vitest";

import { createGrid, RELEASE as RELEASE_DEFAULT } from "../src/index.js";
import { keypairOf } from "../src/noise.js";
import { dialGrid } from "../src/wire.js";

/* A hub key pair, raw and base64, as `grid key new` writes it. */
function keys() {
    const pair = keypairOf(
        Buffer.from(
            Array.from({ length: 32 }, () => {
                return Math.floor(Math.random() * 256);
            }),
        ),
    );

    return { pair, private: pair.private.toString("base64"), public: pair.public.toString("base64") };
}

const RELEASE = { version: "2.0.0", sha256: { arm: "a".repeat(64), x86: "b".repeat(64) } };

/* A free port, from the OS. */
function freePort(): number {
    return 20_000 + Math.floor(Math.random() * 20_000);
}

describe("grid: the hub plugin", () => {
    it("is a worker that rig opens with a kind of job machines", async () => {
        const hub = keys();
        const grid = createGrid({ ip: "203.0.113.9", identity: hub.private, release: RELEASE });

        expect(grid).toMatchObject({ slot: "worker", name: "grid", rig: 1 });

        const provider: Provider = {
            slot: Slot.PROVIDER,
            name: "a",
            rig: 1,
            can: { port: true },
            distros: { ubuntu: ["24.04"], debian: ["12"] },
            async places() {
                return [];
            },
            async create() {
                return { busy: "zone" as never };
            },
            async get() {
                return null;
            },
            async list() {
                return [];
            },
            async end() {},
            async reboot() {},
            port: {
                async open(_id, rule) {
                    return rule;
                },
                async close() {},
                async list() {
                    return [];
                },
            },
        };

        const rig = createRig({
            rig: 1,
            app: "app",
            providers: [provider],
            workers: [grid],
            kinds: [
                {
                    name: "builder",
                    try: [{ provider: "a", market: [Market.DEMAND], types: ["t"] }],
                    worker: { tags: ["build"], cmds: { make: { exec: ["make"] } } },
                },
            ],
            store: mkdtempSync(path.join(tmpdir(), "rig-grid-")),
            extra: { rounds: false },
        });

        await expect(rig.open()).resolves.toBeUndefined();

        expect(grid).toMatchObject({ key: hub.public, ip: "203.0.113.9" });
        await rig.close();
        await grid.close();
    });

    it("sets a machine up: grid installed and checked, its node.toml, the hub's port, and its own key", async () => {
        const hub = keys();
        const grid = createGrid({ ip: "203.0.113.9", identity: hub.private, release: RELEASE, listen: 9500 });

        await grid.open();
        const worker = { tags: ["build"], cmds: { make: { exec: ["make", "-j8"], timeout: "1h" } }, signal: true };
        const { script, ports, key } = grid.setup({ name: "app-builder-0a1b2c3d", tags: ["build"], worker });

        const fileOf = (path: string): string => {
            const line = script.find((one) => {
                return one.endsWith(`| base64 -d > ${path}`);
            })!;

            return Buffer.from(line.split("'")[1]!, "base64").toString();
        };

        expect(fileOf("/etc/grid/node.toml")).toBe(
            [
                "grid = 2",
                'identity = "/etc/grid/node.key"',
                'tags = ["build"]',
                "port = 9420",
                "signal = true",
                "",
                "[[hubs]]",
                'ip = "203.0.113.9"',
                "port = 9500",
                'trust = "/etc/grid/hub.pub"',
                "",
                "[cmds.make]",
                'exec = ["make", "-j8"]',
                'timeout = "1h"',
                "",
            ].join("\n"),
        );

        expect(script).toContain(`echo '${hub.public}' > /etc/grid/hub.pub`);
        expect(script.join("\n")).toContain('--strip-components=1 --no-same-owner "grid_2.0.0_linux_${arch}/grid"');
        expect(ports).toEqual([{ port: 9420, from: "203.0.113.9/32" }]);
        expect(key).toMatch(/^[A-Za-z0-9+/]{43}=$/);

        expect(() => {
            grid.check({ tags: ["build"], cmds: {} });
        }).toThrow(/at least one cmd/);

        expect(() => {
            createGrid({ ip: "203.0.113.9", identity: hub.private }).check({ ...worker });
        }).toThrow(/needs a hub with listen/);
    });

    it("has a default for all but its key: the package's own grid release, and the app host's IP", async () => {
        const grid = createGrid({ identity: keys().private, reach: "private" });

        await grid.open();

        const { script } = grid.setup({
            name: "app-b-1",
            tags: ["build"],
            worker: { tags: ["build"], cmds: { make: { exec: ["make"] } } },
        });

        expect(isIP(grid.ip)).not.toBe(0);
        expect(script).toContain(`    aarch64) arch=arm64; sha=${RELEASE_DEFAULT.sha256.arm} ;;`);
        expect(script.join("\n")).toContain(`/download/v${RELEASE_DEFAULT.version}/`);
        await grid.close();
    });

    it("fails a waiting job once its tag is spent, and takes jobs again when a node with it comes", async () => {
        const grid = createGrid({ ip: "127.0.0.1", identity: keys().private, release: RELEASE });

        await grid.open();

        await grid.spent(["build"]);

        expect(await grid.run({ tag: "build", steps: [{ cmd: "make" }] })).toMatchObject({
            state: "failed",
            message: "no build node comes for it",
        });

        await grid.add({ name: "m1", ip: { public: "127.0.0.1" }, key: keys().public, tags: ["build"] });

        const stop = new AbortController();
        const waiting = grid.run({ tag: "build", steps: [{ cmd: "make" }] }, { signal: stop.signal });

        await sleep(100);
        stop.abort();

        expect(await waiting).toMatchObject({ state: "stopped" });
        await grid.close();
    });

    it("updates a node it knows in place, counts a dropped one as lost, and tries a port that would not bind again", async () => {
        const grid = createGrid({ ip: "127.0.0.1", identity: keys().private, release: RELEASE });

        await grid.open();
        const key = keys().public;

        await grid.add({ name: "m1", ip: { public: "127.0.0.1" }, key, tags: ["build"] });
        await grid.add({ name: "m1", ip: { public: "127.0.0.2" }, key, tags: ["build"] });

        expect(grid.nodes()).toMatchObject([{ name: "m1", ip: "127.0.0.2", lost: false }]);

        await grid.drop("m1");

        expect(grid.nodes()).toEqual([]);
        await grid.close();

        const port = freePort();
        const taken = createGrid({ ip: "127.0.0.1", identity: keys().private, release: RELEASE, listen: port });

        await taken.open();
        const busy = createGrid({ ip: "127.0.0.1", identity: keys().private, release: RELEASE, listen: port });

        await busy.open();

        await taken.add({ name: "m1", ip: { public: "127.0.0.1" }, key, tags: ["build"] });
        await expect(busy.add({ name: "m2", ip: { public: "127.0.0.1" }, key, tags: ["build"] })).rejects.toThrow();

        await taken.close();

        await expect(
            busy.add({ name: "m2", ip: { public: "127.0.0.1" }, key, tags: ["build"] }),
        ).resolves.toBeUndefined();

        await busy.close();
    });

    it("listens for nodes with signal: a node it knows beats; one it does not is closed", async () => {
        const hub = keys();
        const node = keys();
        const stranger = keys();
        const listen = freePort();
        const grid = createGrid({ ip: "127.0.0.1", identity: hub.private, release: RELEASE, listen });

        await grid.open();

        await grid.add({ name: "m1", ip: { public: "127.0.0.1" }, key: node.public, tags: ["build"] });

        const known = await dialGrid({ ip: "127.0.0.1", port: listen, local: node.pair, remote: hub.pair.public });

        expect(await known.request("beat", { tags: ["build"], free: 1, share: false })).toEqual({});

        known.close();

        await expect(
            dialGrid({ ip: "127.0.0.1", port: listen, local: stranger.pair, remote: hub.pair.public }),
        ).rejects.toThrow();

        await grid.close();
    });
});

/* grid's own node, when it is installed: the hub dials it, and runs a job on it. */
const hasGrid = ((): boolean => {
    try {
        execFileSync("grid", ["version"], { stdio: "ignore" });

        return true;
    } catch {
        return false;
    }
})();

describe.skipIf(!hasGrid)("grid: with grid's own node", () => {
    const folder = mkdtempSync(path.join(tmpdir(), "rig-grid-node-"));
    const nodes: ChildProcess[] = [];

    afterAll(() => {
        for (const one of nodes) {
            one.kill();
        }

        rmSync(folder, { recursive: true, force: true });
    });

    it("runs a job on a real grid node, and pulls what it wrote", async () => {
        const hub = keys();
        const port = freePort();

        execFileSync("grid", ["key", "new", path.join(folder, "node")]);
        writeFileSync(path.join(folder, "hub.pub"), `${hub.public}\n`);

        writeFileSync(
            path.join(folder, "node.toml"),
            [
                "grid = 2",
                `identity = "${path.join(folder, "node.key")}"`,
                'tags = ["build"]',
                `port = ${port}`,
                "",
                "[[hubs]]",
                'ip = "127.0.0.1"',
                `trust = "${path.join(folder, "hub.pub")}"`,
                "",
                "[jobs]",
                `path = "${path.join(folder, "jobs")}"`,
                "",
                "[history]",
                `path = "${path.join(folder, "history")}"`,
                "",
                "[share]",
                `path = "${path.join(folder, "share")}"`,
                "",
                "[cmds.hello]",
                'exec = ["sh", "-c", "mkdir -p out && echo hi > out/hi.txt"]',
                "",
            ].join("\n"),
        );

        const node = spawn("grid", ["node", "run", "--config", path.join(folder, "node.toml")], { stdio: "ignore" });

        nodes.push(node);
        await sleep(1000);

        const grid = createGrid({ ip: "127.0.0.1", identity: hub.private, release: RELEASE, port });

        await grid.open();
        const key = readFileSync(path.join(folder, "node.pub"), "utf8").trim();
        const into = path.join(folder, "pulled");

        await grid.add({ name: "m1", ip: { public: "127.0.0.1" }, key, tags: ["build"] });

        const outcome = await grid.run({ tag: "build", steps: [{ cmd: "hello" }], pull: [{ path: "out", into }] });

        expect(outcome).toMatchObject({ state: "done" });
        expect(existsSync(path.join(into, "hi.txt")) || existsSync(path.join(into, "out", "hi.txt"))).toBe(true);

        await grid.close();
    }, 30_000);

    it("hears a real grid node with signal beat into its listener", async () => {
        const hub = keys();
        const port = freePort();
        const listen = freePort();
        const base = path.join(folder, "signal");

        execFileSync("mkdir", ["-p", base]);
        execFileSync("grid", ["key", "new", path.join(base, "node")]);
        writeFileSync(path.join(base, "hub.pub"), `${hub.public}\n`);

        writeFileSync(
            path.join(base, "node.toml"),
            [
                "grid = 2",
                `identity = "${path.join(base, "node.key")}"`,
                'tags = ["build"]',
                `port = ${port}`,
                "signal = true",
                "",
                "[[hubs]]",
                'ip = "127.0.0.1"',
                `port = ${listen}`,
                `trust = "${path.join(base, "hub.pub")}"`,
                "",
                "[jobs]",
                `path = "${path.join(base, "jobs")}"`,
                "",
                "[history]",
                `path = "${path.join(base, "history")}"`,
                "",
                "[share]",
                `path = "${path.join(base, "share")}"`,
                "",
            ].join("\n"),
        );

        const grid = createGrid({ ip: "127.0.0.1", identity: hub.private, release: RELEASE, port, listen });

        await grid.open();
        const key = readFileSync(path.join(base, "node.pub"), "utf8").trim();

        await grid.add({ name: "m1", ip: { public: "127.0.0.1" }, key, tags: ["build"] });

        const node = spawn("grid", ["node", "run", "--config", path.join(base, "node.toml")], { stdio: "ignore" });

        nodes.push(node);

        for (let waited = 0; waited < 12_000 && !grid.nodes()[0]!.beating; waited += 500) {
            await sleep(500);
        }

        expect(grid.nodes()).toMatchObject([{ name: "m1", beating: true, lost: false }]);

        await grid.close();
    }, 30_000);
});
