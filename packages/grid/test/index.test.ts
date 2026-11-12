import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { type NetworkInterfaceInfo } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createGrid, type Grid } from "../src/index.js";
import { dialGrid } from "../src/wire.js";
import { freePort, randomPair, RELEASE, tempFolder, until } from "./helpers.js";

/* The host's network, as the test gives it: the real one unless a test sets its own. */
const network = vi.hoisted(() => {
    return { interfaces: null as Record<string, NetworkInterfaceInfo[]> | null };
});

vi.mock("node:os", async (importOriginal) => {
    const os = await importOriginal<typeof import("node:os")>();

    return {
        ...os,
        networkInterfaces: () => {
            return network.interfaces ?? os.networkInterfaces();
        },
    };
});

const grids: Grid[] = [];
let folder = "";

beforeEach(() => {
    folder = tempFolder("grid-index-test-");
});

afterEach(async () => {
    vi.unstubAllGlobals();
    network.interfaces = null;

    for (const grid of grids.splice(0)) {
        await grid.close();
    }

    rmSync(folder, { recursive: true, force: true });
});

function gridOf(config: Parameters<typeof createGrid>[0]): Grid {
    const grid = createGrid({ release: RELEASE, ...config });

    grids.push(grid);

    return grid;
}

/* What `fetch` gives for the host's public IP. */
function answering(answer: () => Promise<Response>) {
    vi.stubGlobal("fetch", vi.fn(answer));
}

describe("grid config", () => {
    it("refuses an ip that is not an IP, and an identity that is neither a key nor a file holding one", async () => {
        expect(() => {
            return createGrid({ ip: "not-an-ip" });
        }).toThrow("grid: ip is not an IP");

        await expect(gridOf({ ip: "127.0.0.1", identity: path.join(folder, "none.key") }).open!()).rejects.toThrow(
            "grid: identity is not a key, or a file holding one",
        );
    });

    it("reads its key from a file, and makes one at the default path on first use", async () => {
        const pair = randomPair();
        const file = path.join(folder, "hub.key");

        writeFileSync(file, `${pair.private.toString("base64")}\n`);

        const fromFile = gridOf({ ip: "127.0.0.1", identity: file });

        await fromFile.open!();
        await fromFile.open!();
        expect(fromFile.key).toBe(pair.public.toString("base64"));

        const cwd = process.cwd();

        process.chdir(folder);

        try {
            const made = gridOf({ ip: "127.0.0.1" });

            await made.open!();
            expect(existsSync(path.join(folder, ".rig", "grid", "hub.key"))).toBe(true);

            const again = gridOf({ ip: "127.0.0.1" });

            await again.open!();
            expect(again.key).toBe(made.key);

            expect(readFileSync(path.join(folder, ".rig", "grid", "hub.key"), "utf8")).toMatch(
                /^[A-Za-z0-9+/]{43}=\n$/,
            );
        } finally {
            process.chdir(cwd);
        }
    });

    it("is not open before rig opens it: no key, no IP, no nodes, no setup", async () => {
        const grid = gridOf({ ip: "127.0.0.1", identity: randomPair().private.toString("base64") });

        expect(() => {
            return grid.key;
        }).toThrow("not open yet");

        expect(() => {
            return grid.setup({ name: "m", tags: [], worker: { tags: [], cmds: {} } });
        }).toThrow("not open yet");

        expect(grid.nodes()).toEqual([]);
        await expect(grid.add({ name: "m", ip: { public: "127.0.0.1" }, key: "", tags: [] })).rejects.toThrow();
    });

    it("finds its public IP by asking, and refuses to open when it finds none", async () => {
        const identity = randomPair().private.toString("base64");

        answering(async () => {
            return new Response("198.51.100.7\n");
        });

        const found = gridOf({ identity });

        await found.open!();
        expect(found.ip).toBe("198.51.100.7");

        await expect(found.add({ name: "m1", ip: { private: "10.0.0.9" }, key: "", tags: [] })).rejects.toThrow(
            "grid: m1 has no public IP yet",
        );

        const answers: (() => Promise<Response>)[] = [
            async () => {
                return new Response("", { status: 503 });
            },
            async () => {
                throw new Error("offline");
            },
            async () => {
                return new Response("not an ip");
            },
        ];

        for (const answer of answers) {
            answering(answer);
            await expect(gridOf({ identity }).open!()).rejects.toThrow("grid: no public IP found for the hub");
        }
    });

    it("finds its private IP on the host's network, and refuses to open when it has none", async () => {
        const identity = randomPair().private.toString("base64");
        const loopback = { address: "127.0.0.1", family: "IPv4", internal: true } as NetworkInterfaceInfo;
        const lan = { address: "10.0.0.5", family: "IPv4", internal: false } as NetworkInterfaceInfo;

        network.interfaces = { lo0: [loopback], en0: [lan] };

        const grid = gridOf({ identity, reach: "private", extra: { tars: path.join(folder, "tars") } });

        await grid.open!();
        expect(grid.ip).toBe("10.0.0.5");

        /* It dials a machine's private IP, which a machine may not have yet. */
        await expect(grid.add({ name: "m1", ip: { public: "198.51.100.1" }, key: "", tags: [] })).rejects.toThrow(
            "grid: m1 has no private IP yet",
        );

        await grid.add({
            name: "m1",
            ip: { private: "10.0.0.9" },
            key: randomPair().public.toString("base64"),
            tags: [],
        });

        expect(grid.nodes()).toMatchObject([{ name: "m1", ip: "10.0.0.9" }]);

        network.interfaces = { lo0: [loopback] };
        await expect(gridOf({ identity, reach: "private" }).open!()).rejects.toThrow("grid: no private IP found");

        await expect(
            gridOf({ ip: "127.0.0.1", identity }).add({ name: "m", ip: {}, key: "", tags: [] }),
        ).rejects.toThrow("not open yet");
    });

    it("recovers through its hub, and refuses a session no node comes for", async () => {
        const grid = gridOf({ ip: "127.0.0.1", identity: randomPair().private.toString("base64") });

        await grid.open!();
        expect(await grid.recover("127.0.0.1:9420", "j1", [])).toBe(false);

        await grid.spent(["build"]);
        await expect(grid.session({ tag: "build" })).rejects.toThrow("no build node comes for");
    });
});

describe("grid listener", () => {
    it("fails an add on a port that will not bind, and drops and closes while it tries", async () => {
        const taken = createServer();
        const listen = await freePort();

        await new Promise<void>((resolve) => {
            taken.listen(listen, resolve);
        });

        const grid = gridOf({ ip: "127.0.0.1", identity: randomPair().private.toString("base64"), listen });

        await grid.open!();

        const adding = grid.add({ name: "m1", ip: { public: "127.0.0.1" }, key: "", tags: [] });
        const dropping = grid.drop("m1");
        const closing = grid.close();

        await expect(adding).rejects.toThrow("EADDRINUSE");
        await expect(dropping).resolves.toBeUndefined();
        await expect(closing).resolves.toBeUndefined();

        await new Promise((resolve) => {
            taken.close(resolve);
        });
    });

    it("closes a node at an IP it does not know, refuses a call it does not take, and drops a node's connections", async () => {
        const hub = randomPair();
        const node = randomPair();
        const listen = await freePort();
        const lines: string[] = [];

        const grid = gridOf({
            ip: "127.0.0.1",
            identity: hub.private.toString("base64"),
            listen,
            extra: {
                log: (line) => {
                    lines.push(line);
                },
            },
        });

        const dial = () => {
            return dialGrid({ ip: "127.0.0.1", port: listen, local: node, remote: hub.public });
        };

        await grid.open!();
        await grid.add({ name: "far", ip: { public: "127.0.0.2" }, key: node.public.toString("base64"), tags: [] });
        await expect(dial()).rejects.toThrow();

        await grid.add({ name: "m1", ip: { public: "127.0.0.1" }, key: node.public.toString("base64"), tags: [] });

        const known = await dial();
        const closed: string[] = [];

        known.onClose((problem) => {
            closed.push(problem.message);
        });

        await expect(known.request("dance", {})).rejects.toThrow("invalid: the hub takes no dance");
        expect(await known.request("post", { job: "j1" })).toEqual({});
        expect(await known.request("beat", { share: true })).toEqual({});
        expect(await known.request("beat", { share: false })).toEqual({});
        expect(await known.request("beat", {})).toEqual({});
        expect(grid.nodes({ beating: true })).toMatchObject([{ name: "m1" }]);

        /* Another key at a node's IP is not that node. */
        await expect(
            dialGrid({ ip: "127.0.0.1", port: listen, local: randomPair(), remote: hub.public }),
        ).rejects.toThrow();

        await until(() => {
            return lines.some((line) => {
                return line.startsWith("a node at 127.0.0.1 did not join: ");
            });
        });

        await grid.drop("m1");

        await until(() => {
            return closed.length === 1;
        });

        /* Closing the hub closes the connections nodes keep open. */
        await grid.add({ name: "m1", ip: { public: "127.0.0.1" }, key: node.public.toString("base64"), tags: [] });

        const kept = await dial();

        await grid.close();

        await until(() => {
            return !kept.isOpen;
        });
    });
});
