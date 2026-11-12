import { sleep } from "radash";
import { afterEach, describe, expect, it, vi } from "vitest";

import { JobBook, JobEvent } from "../src/book.js";
import { NodeLink } from "../src/nodes.js";
import { FakeNode } from "./fake-node.js";
import { randomPair } from "./helpers.js";

afterEach(() => {
    vi.restoreAllMocks();
});

describe("grid job book", () => {
    it("tells a job placed, run again after a lost node, and ended; a handler that throws stops nothing", () => {
        const book = new JobBook();
        const told: string[] = [];

        book.on(JobEvent.PLACED, () => {
            throw new Error("the app's own");
        });

        book.on(JobEvent.PLACED, ({ job }) => {
            told.push(`placed ${job.node}`);
        });

        book.on(JobEvent.RETRIED, ({ job, lost }) => {
            told.push(`retried ${lost} ${job.state} ${job.node ?? "none"}`);
        });

        book.on(JobEvent.ENDED, ({ job, outcome }) => {
            told.push(`ended ${job.name} ${outcome ? "with" : "without"} an outcome`);
        });

        const one = book.start("a", "build", false)!;

        book.placed(one, "m1");
        book.event(one, { seq: 1, time: 1, type: "state", data: { state: "running", cmd: "make" } });
        expect(book.get("a")).toMatchObject({ state: "running", node: "m1", step: "make", tries: 1 });

        book.retried(one, "m1");
        expect(book.get("a")).toEqual(expect.not.objectContaining({ node: "m1", step: "make" }));

        book.end(one);
        book.end(one);

        expect(told).toEqual(["placed m1", "retried m1 waiting none", "ended a without an outcome"]);
    });

    it("lists jobs by node, names one of its own, gives a view the app cannot change, and stops watching", () => {
        const book = new JobBook();
        const one = book.start(undefined, "build", false)!;
        const other = book.start("b", "build", true)!;
        const heard: number[] = [];

        expect(one.view.name).toMatch(/^job-[0-9a-f]{8}$/);
        book.placed(other, "m2");

        expect(
            book.list({ node: "m2" }).map((view) => {
                return view.name;
            }),
        ).toEqual(["b"]);

        book.list()[0]!.tag = "changed";
        expect(book.get(one.view.name)!.tag).toBe("build");

        const unwatch = book.watch("b", (event) => {
            heard.push(event.seq);
        });

        book.event(other, { seq: 1, time: 1, type: "log", data: "hi" });
        unwatch();
        book.event(other, { seq: 2, time: 2, type: "log", data: "hi" });

        expect(heard).toEqual([1]);
        expect(book.kill("none")).toBe(false);
    });
});

describe("grid node link", () => {
    it("is lost 15 s after its last beat, and 30 s into a spell of failed calls without one", () => {
        const lines: string[] = [];
        const link = new NodeLink(new FakeNode().entry("m1"), randomPair(), (line) => {
            lines.push(line);
        });

        const now = Date.now();
        const clock = vi.spyOn(Date, "now").mockReturnValue(now);

        link.failed("not an error");
        link.failed(new Error("again"));
        clock.mockReturnValue(now + 31_000);
        expect(link.isLost).toBe(true);

        link.beat();
        expect(link.isBeating).toBe(true);
        expect(link.isLost).toBe(false);
        clock.mockReturnValue(now + 31_000 + 16_000);
        expect(link.isLost).toBe(true);

        expect(lines).toEqual(["node 127.0.0.1:0 does not answer: no answer", "node 127.0.0.1:0 answers again"]);
    });

    it("takes a new share hint on an update, and keeps what the node said while the hint stays", () => {
        const entry = new FakeNode().entry("m1");
        const link = new NodeLink(entry, randomPair(), () => {});

        expect(link.isSharing).toBe(false);

        link.update({ ...entry, share: true });
        expect(link.isSharing).toBe(true);

        /* The node says its share is off: the same hint again keeps that. */
        link.shares(false);
        link.update({ ...entry, share: true });
        expect(link.isSharing).toBe(false);

        /* The node says its share is on; a new hint, off, takes over. */
        link.shares(true);
        link.update(entry);
        expect(link.isSharing).toBe(false);
    });

    it("keeps its connection when the same node comes again, and dials anew once it moves", async () => {
        const node = await new FakeNode().start();
        const link = new NodeLink(node.entry("m1"), randomPair(), () => {});

        const connection = await link.connect();

        expect(await link.connect()).toBe(connection);

        link.update(node.entry("m1", ["build", "test"]));
        expect(await link.connect()).toBe(connection);

        link.update({ ...node.entry("m1"), trust: randomPair().public });
        expect(connection.isOpen).toBe(false);

        /* A connection the node closes is forgotten: the next call dials again. */
        link.update(node.entry("m1"));
        const again = await link.connect();

        node.cut();

        for (let waited = 0; waited < 2000 && again.isOpen; waited += 10) {
            await sleep(10);
        }

        expect(await link.connect()).not.toBe(again);

        link.close();
        await expect(link.connect()).rejects.toThrow("was dropped");
        expect(link.isLost).toBe(true);
        await node.stop();
    });
});
