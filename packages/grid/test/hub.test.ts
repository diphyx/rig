import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { JobBook } from "../src/book.js";
import { GridHub } from "../src/hub.js";
import { FakeNode, hubsForEach, tarOf } from "./fake-node.js";
import { randomPair, until } from "./helpers.js";

import type { GridEvent } from "../src/job.js";

const { setUp, closers } = hubsForEach();

/* A node's address where nothing listens any more. */
async function deadNode(): Promise<FakeNode> {
    const node = await new FakeNode().start();

    await node.stop();

    return node;
}

describe("grid hub", () => {
    it("tries each node with the tag, notes once that none has room, and places the job when one does", async () => {
        const { hub, nodes, lines } = await setUp(3);
        const [refusing, full, jobless] = nodes as [FakeNode, FakeNode, FakeNode];
        const dead = await deadNode();
        let isFull = true;

        refusing.handlers.open = (call) => {
            call.reject("invalid", "not now");
        };

        const open = full.handlers.open!;

        full.handlers.open = (call) => {
            if (isFull) {
                isFull = false;
                call.reject("full");

                return;
            }

            return open(call);
        };

        jobless.handlers.open = (call) => {
            call.ok({});
        };

        hub.add(dead.entry("m4"));

        const outcome = await hub.run({ name: "req", tag: "build", steps: [{ cmd: "make" }] });

        expect(outcome).toMatchObject({ state: "done", node: full.address });
        expect(lines).toContain("req (make) waits: no build node has room");
        expect(lines).toContain(`node ${jobless.address} does not answer: no answer`);

        expect(
            lines.filter((line) => {
                return line.startsWith(`node ${dead.address} does not answer: `);
            }),
        ).toHaveLength(1);
    });

    it("runs a job with no log and no tars folder of its own given", async () => {
        const node = await new FakeNode().start();
        const hub = new GridHub(randomPair(), { book: new JobBook() });

        closers.push(async () => {
            hub.close();
            await node.stop();
        });

        hub.add(node.entry("m1"));
        expect(await hub.run({ tag: "build", steps: [{ cmd: "make" }] })).toMatchObject({ state: "done" });
    });

    it("runs no job with a name that is not one, a share at the space, or a push it cannot pack", async () => {
        const { hub, folder } = await setUp();
        const steps = [{ cmd: "make" }];
        const source = path.join(folder, "in.txt");

        writeFileSync(source, "x");

        expect(await hub.run({ name: "", tag: "build", steps })).toMatchObject({
            name: "",
            state: "failed",
            message: "name: not a str",
            steps: [{ cmd: "make", state: "idle" }],
        });

        expect(await hub.run({ name: 7 as unknown as string, tag: "build", steps })).toMatchObject({
            message: "name: not a str",
        });

        expect(await hub.run({ tag: "build", steps, push: [{ from: source, share: true }] })).toMatchObject({
            state: "failed",
            message: "push 1: a share needs a `to`, not the space",
        });

        expect(
            await hub.run({ tag: "build", steps, push: [{ from: source }, { from: path.join(folder, "none") }] }),
        ).toMatchObject({ state: "failed", message: expect.stringMatching(/^push: ENOENT/) });

        await expect(hub.session({ name: "", tag: "build" })).rejects.toThrow("grid: name: not a str");

        hub.spent(["gpu"]);
        await expect(hub.session({ name: "s1", tag: "gpu" })).rejects.toThrow("grid: no gpu node comes for s1");
    });

    it("runs a session's calls on its node: one that fails a step fails it, with its message or without; none failed is done", async () => {
        const { hub, node, lines } = await setUp();
        const events: GridEvent[] = [];

        const ends = [
            ["done", ""],
            ["failed", "exit 1"],
            ["failed", ""],
        ];

        node.handlers.exec = (call) => {
            const [state, message] = ends.shift()!;

            call.ok();
            node.run(String(call.body.job), String(call.body.cmd), state!, message);
        };

        const session = await hub.session({
            name: "s1",
            tag: "build",
            share: true,
            placed: () => {
                throw new Error("the app's own");
            },
            watch: (event) => {
                events.push(event);
            },
        });

        expect(await session.exec({ cmd: "make" })).toEqual({ cmd: "make", state: "done", message: "" });
        expect(await session.exec({ cmd: "test" })).toEqual({ cmd: "test", state: "failed", message: "exit 1" });

        expect(await session.close()).toMatchObject({
            name: "s1",
            state: "failed",
            message: "step 2 (test): failed: exit 1",
            node: node.address,
        });

        expect(events.length).toBeGreaterThan(0);
        expect(lines.at(-1)).toMatch(/^s1 \(make, test\) failed in /);

        const other = await hub.session({ tag: "build" });

        await other.exec({ cmd: "lint" });
        expect(await other.close()).toMatchObject({ state: "failed", message: "step 1 (lint): failed" });

        const idle = await hub.session({ tag: "build" });

        expect(await idle.close()).toMatchObject({ state: "done", message: "", steps: [] });
    });

    it("runs a session's push, exec and pull; a kill stops its step, and leaves it only pulls and close", async () => {
        const { hub, book, node, folder } = await setUp();
        const source = path.join(folder, "lib");
        const into = path.join(folder, "into");

        mkdirSync(source);
        writeFileSync(path.join(source, "job.sh"), "echo hi\n");
        node.pulls.set("out", { files: [{ path: "a.txt", size: 1, modified: 1 }], tar: await tarOf({ "a.txt": "a" }) });

        node.handlers.exec = (call) => {
            call.ok();
            node.run(String(call.body.job), String(call.body.cmd), "running");
        };

        const session = await hub.session({ name: "s2", tag: "build" });

        expect(session.name).toBe("s2");
        expect(hub.nodes()).toMatchObject([{ name: "m1", jobs: ["s2"] }]);
        expect(await session.push({ from: source, to: "lib", share: true })).toEqual({ to: "lib", how: "normal" });
        await expect(session.pull({ path: ".", into })).rejects.toThrow("grid: pull .: it takes in push 1, a share");

        const running = session.exec({ cmd: "wait" });

        await until(() => {
            return node.calls("exec").length === 1;
        });

        expect(book.kill("s2")).toBe(true);
        node.emit("j1", "state", { state: "running", cmd: "other" });

        expect(await running).toEqual({ cmd: "wait", state: "stopped", message: "killed" });
        await expect(session.exec({ cmd: "wait" })).rejects.toThrow("grid: job s2 was killed");
        expect(await session.pull({ path: "out", into })).toMatchObject([{ path: "a.txt" }]);

        const closing = session.close();

        expect(session.close()).toBe(closing);

        expect(await closing).toMatchObject({
            state: "stopped",
            message: "killed",
            pushed: [{ to: "lib", how: "normal" }],
            files: [{ path: "a.txt" }],
        });

        await expect(session.push({ from: source, to: "other" })).rejects.toThrow("grid: job s2 is closed");
    });

    it("recovers a job it opened before: stopped if it runs, its files pulled, then dropped", async () => {
        const { hub, node, folder, lines } = await setUp();
        const into = path.join(folder, "into");
        const states = ["running", "exited"];

        node.pulls.set("out", { files: [{ path: "a.txt", size: 1, modified: 1 }], tar: await tarOf({ "a.txt": "a" }) });

        node.handlers.kill = (call) => {
            call.reject("invalid", "not running");
        };

        node.handlers.stat = (call) => {
            call.ok({ state: states.shift() ?? "exited" });
        };

        expect(await hub.recover(node.address, "j9", [{ path: "out", into }])).toBe(true);
        expect(readFileSync(path.join(into, "a.txt"), "utf8")).toBe("a");
        expect(node.calls("stat")).toHaveLength(2);
        expect(node.calls("drop")).toMatchObject([{ body: { job: "j9" } }]);

        /* A job that stops at once is not asked about again. */
        node.handlers.kill = (call) => {
            call.ok();
        };

        expect(await hub.recover(node.address, "j10", [])).toBe(true);

        node.handlers.kill = (call) => {
            call.reject("unknown", "no job j11");
        };

        expect(await hub.recover(node.address, "j11", [])).toBe(false);
        expect(lines).toContain(`job j11 on ${node.address} not recovered: unknown: no job j11`);
        expect(await hub.recover("203.0.113.1:9420", "j12", [])).toBe(false);

        const dead = await deadNode();

        hub.add(dead.entry("m2"));
        expect(await hub.recover(dead.address, "j13", [])).toBe(false);
    });
});
