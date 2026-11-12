import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { JobEvent } from "../src/book.js";
import { Attempt, runAttempt } from "../src/job.js";
import { NodeLink } from "../src/nodes.js";
import { TarStore } from "../src/tars.js";
import { hubsForEach, sha256, tarOf, type FakeNode } from "./fake-node.js";
import { randomPair, until } from "./helpers.js";

import type { GridEvent } from "../src/job.js";

const { setUp } = hubsForEach();

afterEach(() => {
    vi.restoreAllMocks();
});

/* A source folder with one file, in the test's folder. */
function sourceIn(folder: string, name = "source"): string {
    const source = path.join(folder, name);

    mkdirSync(source, { recursive: true });
    writeFileSync(path.join(source, "in.txt"), `${name}\n`);

    return source;
}

/* The tar the hub sends for a source, and its sha256. */
async function packedOf(folder: string, source: string): Promise<{ sum: string; bytes: Buffer }> {
    const packed = await new TarStore(path.join(folder, "expected")).pack(source);

    return { sum: packed.sum, bytes: readFileSync(packed.file) };
}

/* A kill by the job's signal, and a state of another cmd, so the hub hears it at once. */
function abortNow(node: FakeNode, stop: AbortController) {
    stop.abort();
    node.emit(String(node.calls("exec").at(-1)!.body!.job), "state", { state: "running", cmd: "other" });
}

/* A cmd that only starts: its end is the test's. */
function startOnly(node: FakeNode) {
    node.handlers.exec = (call) => {
        call.ok();
        node.run(String(call.body.job), String(call.body.cmd), "running");
    };
}

describe("grid job", () => {
    it("pushes, runs its steps and the next ones, pulls fresh and after, then drops the job", async () => {
        const { hub, node, folder, lines } = await setUp();
        const events: GridEvent[] = [];
        const placed: string[] = [];
        const into = path.join(folder, "into");

        node.pulls.set("out", { files: [{ path: "a.txt", size: 1, modified: 1 }], tar: await tarOf({ "a.txt": "a" }) });

        node.handlers.tail = (call) => {
            return node.tail(call, ["not an event", { seq: 0, time: 0, type: "log", data: "old" }]);
        };

        const pull = node.handlers.pull!;

        /* A pull answered without its files: nothing to lay down. */
        node.handlers.pull = (call) => {
            if (call.body.path !== "bare") {
                return pull(call);
            }

            call.ok();
            call.end();
        };

        node.handlers.exec = (call) => {
            call.ok();
            node.emit(String(call.body.job), "log", "a line");
            node.emit(String(call.body.job), "state", "not a state");
            node.emit(String(call.body.job), "state", { state: "idle" });
            node.run(String(call.body.job), String(call.body.cmd), "done");
        };

        let isFirst = true;

        const outcome = await hub.run(
            {
                name: "req-1",
                tag: "build",
                push: [{ from: sourceIn(folder) }],
                steps: [{ cmd: "make", args: ["-j2"], env: { A: "1" } }],
                pull: [
                    { path: "out", into },
                    { path: "none", into },
                    { path: "bare", into },
                ],
            },
            {
                watch: (event) => {
                    events.push(event);
                },
                placed: (where) => {
                    placed.push(`${where.node} ${where.job}`);
                },
                next: async (step, files) => {
                    if (!isFirst) {
                        return;
                    }

                    isFirst = false;
                    expect(step).toEqual({ cmd: "make", state: "done", message: "" });

                    expect(
                        await files.pull({ path: "out", into: path.join(folder, "early"), fresh: true }),
                    ).toHaveLength(1);

                    return [{ cmd: "test" }];
                },
            },
        );

        expect(outcome).toMatchObject({
            name: "req-1",
            state: "done",
            node: node.address,
            steps: [
                { cmd: "make", state: "done" },
                { cmd: "test", state: "done" },
            ],
            pushed: [{ to: ".", how: "normal" }],
            files: [{ path: "a.txt" }],
        });

        expect(readFileSync(path.join(into, "a.txt"), "utf8")).toBe("a");
        expect(readFileSync(path.join(folder, "early", "a.txt"), "utf8")).toBe("a");
        expect(placed).toEqual([`${node.address} j1`]);
        expect(node.calls("exec")[0]!.body).toEqual({ job: "j1", cmd: "make", args: ["-j2"], env: { A: "1" } });
        expect(node.calls("exec")[1]!.body).toEqual({ job: "j1", cmd: "test" });
        expect(node.calls("pull")[0]!.body).toMatchObject({ path: "out", since: expect.any(Number) });
        expect(node.calls("drop")).toHaveLength(1);

        expect(
            events.map((event) => {
                return event.type;
            }),
        ).toContain("log");

        expect(lines.at(-1)).toMatch(/^req-1 \(make\) done in \d+\.\d s on 127\.0\.0\.1:\d+$/);
    });

    it("tells a share the node had and one it kept, on a node with its share on first", async () => {
        const { hub, nodes, folder, lines } = await setUp(2);
        const [plain, sharing] = nodes as [FakeNode, FakeNode];
        const lib = await packedOf(folder, sourceIn(folder, "lib"));
        const data = await packedOf(folder, sourceIn(folder, "data"));

        /* The second node again, its share on: it comes after the first, and is tried before it. */
        hub.drop("m2");
        hub.add(sharing.entry("m2", ["build"], true));

        sharing.handlers.push = async (call) => {
            if (call.body.id === lib.sum.slice(0, 32)) {
                call.data({ have: true });
                await sharing.collect(call);
                call.ok({ sha256: Buffer.from(lib.sum, "hex") });

                return;
            }

            call.data({});
            const bytes = await sharing.collect(call);

            sharing.pushed.push(bytes);
            call.ok({ sha256: sha256(bytes), share: true });
        };

        const outcome = await hub.run({
            name: "shares",
            tag: "build",
            push: [
                { from: path.join(folder, "lib"), to: "lib", share: true },
                { from: path.join(folder, "data"), to: "data/", share: true },
            ],
            steps: [{ cmd: "make" }],
        });

        expect(outcome).toMatchObject({
            state: "done",
            node: sharing.address,
            pushed: [
                { to: "lib", how: "hit" },
                { to: "data/", how: "installed" },
            ],
        });

        expect(sharing.pushed).toEqual([data.bytes]);
        expect(plain.calls("open")).toEqual([]);
        expect(lines.at(-1)).toMatch(/; shares: 1 hit, 1 installed$/);
    });

    it("resumes a push at the node's offset, fails one the node refuses, and sends again one whose sha256 differs", async () => {
        const { hub, node, folder, lines } = await setUp();
        const source = sourceIn(folder);
        const packed = await packedOf(folder, source);
        const answers = ["resume", "refuse", "differ", "", "plain"];

        node.handlers.push = async (call) => {
            const answer = answers.shift();

            if (answer === "refuse") {
                call.reject("invalid", "no room");

                return;
            }

            /* An offer of no map is one of nothing: the whole tar. */
            call.data(answer === "plain" ? null : { offset: 512 });
            const bytes = await node.collect(call);

            node.pushed.push(bytes);
            call.ok({ sha256: answer === "differ" ? sha256(bytes) : sha256(packed.bytes) });
        };

        const job = { tag: "build", push: [{ from: source }], steps: [{ cmd: "make" }] };

        expect(await hub.run(job)).toMatchObject({ state: "done" });
        expect(node.pushed).toEqual([packed.bytes.subarray(512)]);
        expect(await hub.run(job)).toMatchObject({ state: "failed", message: "invalid: no room", node: node.address });

        /* A push whose sha256 differs is sent again; the node still answers. */
        expect(await hub.run(job)).toMatchObject({ state: "done" });
        expect(node.calls("push")).toHaveLength(4);

        expect(
            lines.some((line) => {
                return line.includes("does not answer");
            }),
        ).toBe(false);

        expect(await hub.run(job)).toMatchObject({ state: "done" });
        expect(node.pushed.at(-1)).toEqual(packed.bytes);
    });

    it("fails a job whose push differs three times, saying so; its node still answers", async () => {
        const { hub, node, folder } = await setUp();
        const source = sourceIn(folder);

        /* Every push taken whole, and answered with another sha256: the right one, a byte short. */
        node.handlers.push = async (call) => {
            call.data(null);
            call.ok({ sha256: sha256(await node.collect(call)).subarray(1) });
        };

        expect(await hub.run({ tag: "build", push: [{ from: source }], steps: [{ cmd: "make" }] })).toMatchObject({
            state: "failed",
            message: "push: sha256 differs, 3 times",
            node: node.address,
        });

        expect(node.calls("push")).toHaveLength(3);
        expect(hub.nodes()[0]).toMatchObject({ lost: false });
    });

    it("fails a step that does not end done, with its message or without, and still pulls", async () => {
        const { hub, node, folder } = await setUp();

        const ends = [
            ["failed", "exit 2"],
            ["stopped", ""],
        ];

        node.pulls.set("out", { files: [{ path: "a.txt", size: 1, modified: 1 }], tar: await tarOf({ "a.txt": "a" }) });

        node.handlers.exec = (call) => {
            const [state, message] = ends.shift()!;

            call.ok();
            node.run(String(call.body.job), String(call.body.cmd), state!, message);
        };

        const job = {
            tag: "build",
            steps: [{ cmd: "make" }, { cmd: "never" }],
            pull: [{ path: "out", into: path.join(folder, "into") }],
        };

        expect(await hub.run(job)).toMatchObject({
            state: "failed",
            message: "step 1 (make): failed: exit 2",
            steps: [
                { cmd: "make", state: "failed", message: "exit 2" },
                { cmd: "never", state: "idle" },
            ],
            files: [{ path: "a.txt" }],
        });

        expect(await hub.run(job)).toMatchObject({ state: "failed", message: "step 1 (make): stopped" });
        expect(node.calls("exec")).toHaveLength(2);
    });

    it("takes a resent exec the node already runs as this step", async () => {
        const { hub, node } = await setUp();

        node.handlers.exec = (call) => {
            call.reject("running");
            node.run(String(call.body.job), String(call.body.cmd), "done");
        };

        expect(await hub.run({ tag: "build", steps: [{ cmd: "make" }] })).toMatchObject({ state: "done" });
    });

    it("fails a cmd the node does not have, and counts a job the node does not have as lost", async () => {
        const { hub, node } = await setUp();

        node.handlers.exec = (call) => {
            call.reject("unknown");
        };

        expect(await hub.run({ tag: "build", steps: [{ cmd: "nope" }] })).toMatchObject({
            state: "failed",
            message: "no cmd nope on this node",
        });

        node.handlers.stat = (call) => {
            call.reject("unknown");
        };

        expect(await hub.run({ tag: "build", steps: [{ cmd: "nope" }] })).toMatchObject({
            state: "failed",
            message: "node lost; no retries left",
            node: null,
        });
    });

    it("runs a job again on another node when its node is lost, and tells it", async () => {
        const { hub, book, nodes } = await setUp(2);
        const [first, second] = nodes as [FakeNode, FakeNode];
        const retried: string[] = [];

        book.on(JobEvent.RETRIED, ({ job, lost }) => {
            retried.push(`${job.name} ${lost}`);
        });

        first.handlers.exec = () => {
            hub.drop("m1");
        };

        const outcome = await hub.run({ name: "again", tag: "build", steps: [{ cmd: "make" }], retries: 1 });

        expect(outcome).toMatchObject({ state: "done", node: second.address });
        expect(retried).toEqual(["again m1"]);
    });

    it("fails a job whose node refuses to tell its events", async () => {
        const { hub, node } = await setUp();

        node.handlers.tail = (call) => {
            call.reject("invalid", "no tail");
        };

        expect(await hub.run({ tag: "build", steps: [{ cmd: "make" }] })).toMatchObject({
            state: "failed",
            message: "invalid: no tail",
        });
    });

    it("follows the events again after the connection drops, from the last it heard", async () => {
        const { hub, node, lines } = await setUp();
        const tail = node.handlers.tail!;
        let tails = 0;

        node.handlers.tail = (call) => {
            tails += 1;

            /* The first tail ends at once: the hub follows again. */
            if (tails === 1) {
                call.ok();
                call.end();

                return;
            }

            return tail(call);
        };

        node.handlers.exec = (call) => {
            const job = String(call.body.job);

            call.ok();
            node.run(job, "make", "running");

            setTimeout(() => {
                node.cut();
                node.emit(job, "state", { state: "done", cmd: "make", message: "" });
            }, 50);
        };

        expect(await hub.run({ tag: "build", steps: [{ cmd: "make" }] })).toMatchObject({ state: "done" });

        const afters = node.calls("tail").map((envelope) => {
            return envelope.body?.after;
        });

        expect(afters.at(-1)).toBe(1);
        expect(lines).toContain(`node ${node.address} answers again`);
    });

    it("kills a running step, pulls only what it keeps, and leaves the files out when that pull fails", async () => {
        const { hub, node, folder } = await setUp();

        startOnly(node);
        node.pulls.set("out", { files: [{ path: "a.txt", size: 1, modified: 1 }], tar: await tarOf({ "a.txt": "a" }) });

        const job = {
            tag: "build",
            steps: [{ cmd: "make" }],
            pull: [
                { path: "out", into: path.join(folder, "kept"), keep: true },
                { path: "tmp", into: path.join(folder, "tmp") },
            ],
        };

        const stop = new AbortController();
        const running = hub.run(job, { signal: stop.signal });

        await until(() => {
            return node.calls("exec").length === 1;
        });

        abortNow(node, stop);

        expect(await running).toMatchObject({
            state: "stopped",
            message: "killed",
            steps: [{ cmd: "make", state: "stopped", message: "killed" }],
            files: [{ path: "a.txt" }],
        });

        expect(node.calls("kill")).toHaveLength(1);
        expect(existsSync(path.join(folder, "tmp"))).toBe(false);

        node.handlers.pull = (call) => {
            call.ok({ files: [{ path: "a.txt", size: 1, modified: 1 }] });
            call.reject("invalid", "no such path");
        };

        const again = new AbortController();
        const second = hub.run(job, { signal: again.signal });

        await until(() => {
            return node.calls("exec").length === 2;
        });

        abortNow(node, again);
        expect(await second).toMatchObject({ state: "stopped", files: [] });
    });

    it("stops a job without a step when it is aborted once placed, or while it pushes", async () => {
        const { hub, node, folder } = await setUp();
        const stop = new AbortController();

        expect(
            await hub.run(
                { tag: "build", steps: [{ cmd: "make" }] },
                {
                    signal: stop.signal,
                    placed: () => {
                        stop.abort();
                    },
                },
            ),
        ).toMatchObject({ state: "stopped", message: "killed", node: node.address });

        const pushing = new AbortController();

        node.handlers.push = async (call) => {
            pushing.abort();
            call.data({ offset: 0 });
            await node.collect(call);
        };

        expect(
            await hub.run(
                { tag: "build", push: [{ from: sourceIn(folder) }], steps: [{ cmd: "make" }] },
                { signal: pushing.signal },
            ),
        ).toMatchObject({ state: "stopped", message: "killed", node: node.address, steps: [{ state: "idle" }] });

        expect(node.calls("exec")).toEqual([]);
        expect(node.received).toContainEqual({ id: node.calls("push")[0]!.id, cancel: {} });
    });

    it("stops pulling once killed while a pull streams", async () => {
        const { hub, node, folder } = await setUp();
        const stop = new AbortController();

        node.handlers.pull = (call) => {
            stop.abort();
            call.ok({ files: [{ path: "a.txt", size: 1, modified: 1 }] });
        };

        expect(
            await hub.run(
                { tag: "build", steps: [{ cmd: "make" }], pull: [{ path: "out", into: path.join(folder, "into") }] },
                { signal: stop.signal },
            ),
        ).toMatchObject({ state: "stopped", message: "killed" });
    });

    it("resumes a broken pull at what it has, pulls again one whose sha256 differs, and fails one it cannot lay down", async () => {
        const { hub, node, folder } = await setUp();
        const tar = await tarOf({ "a.txt": "a".repeat(3000) });
        const files = [{ path: "a.txt", size: 3000, modified: 1 }];
        const pulls: string[] = ["cut", "differ", "whole"];

        node.handlers.pull = (call) => {
            const how = pulls.shift() ?? "whole";

            if (how === "cut") {
                call.ok({ files });
                call.data(tar.subarray(0, 1000));

                setTimeout(() => {
                    node.cut();
                }, 20);

                return;
            }

            node.sendPull(call, files, tar, how === "differ" ? Buffer.alloc(32) : sha256(tar));
        };

        const into = path.join(folder, "into");

        expect(await hub.run({ tag: "build", steps: [{ cmd: "make" }], pull: [{ path: "out", into }] })).toMatchObject({
            state: "done",
            files,
        });

        expect(readFileSync(path.join(into, "a.txt"), "utf8")).toBe("a".repeat(3000));

        const offsets = node.calls("pull").map((envelope) => {
            return envelope.body?.offset;
        });

        expect(offsets).toEqual([undefined, 1000, undefined]);

        /* A tar with an entry that leaves the folder. */
        const bad = Buffer.alloc(512 * 3);

        bad.write("../x", 0);
        bad.write("0000000\0", 124);
        bad.write("0", 156);

        node.handlers.pull = (call) => {
            node.sendPull(call, files, bad);
        };

        expect(await hub.run({ tag: "build", steps: [{ cmd: "make" }], pull: [{ path: "out", into }] })).toMatchObject({
            state: "failed",
            message: "pull: tar: path ../x leaves the folder",
        });
    });

    it("runs an attempt with no name and no signal: its pulls out of any abort's reach", async () => {
        const { node, folder } = await setUp();
        const link = new NodeLink(node.entry("m1"), randomPair(), () => {});
        const into = path.join(folder, "into");

        node.pulls.set("out", { files: [{ path: "a.txt", size: 1, modified: 1 }], tar: await tarOf({ "a.txt": "a" }) });

        const job = { tag: "build", steps: [{ cmd: "make" }], pull: [{ path: "out", into }] };

        expect(await runAttempt(link, "j1", job, [], {})).toMatchObject({ name: "", state: "done" });

        const attempt = new Attempt(link, "j2", job, {}, folder);

        expect(await attempt.pull({ path: "out", into })).toMatchObject([{ path: "a.txt" }]);
        await attempt.drop();
        link.close();
    });

    it("stops a step whose node never tells its kill", async () => {
        const { hub, node } = await setUp();
        const real = Date.now.bind(Date);
        let ahead = 0;

        startOnly(node);

        node.handlers.kill = (call) => {
            call.ok();

            setTimeout(() => {
                ahead = 20_000;
                node.emit(String(call.body.job), "state", { state: "running", cmd: "other" });
            }, 50);
        };

        vi.spyOn(Date, "now").mockImplementation(() => {
            return real() + ahead;
        });

        const stop = new AbortController();
        const running = hub.run({ tag: "build", steps: [{ cmd: "make" }] }, { signal: stop.signal });

        await until(() => {
            return node.calls("exec").length === 1;
        });

        abortNow(node, stop);

        expect(await running).toMatchObject({
            state: "stopped",
            steps: [{ cmd: "make", state: "stopped", message: "no answer to kill" }],
        });
    });
});
