import type { KindWorker } from "@diphyx/rig";
import { describe, expect, it } from "vitest";

import { checkWorker, hubRule, makeGridKey, nodePart, type HubSide } from "../src/setup.js";
import { shareProblem, spacePath } from "../src/share.js";

const HUB: HubSide = {
    ip: "2001:db8::1",
    port: 9420,
    key: "hub-key",
    release: { version: "2.0.0", sha256: { arm: "a", x86: "b" } },
};

describe("grid setup", () => {
    it("lets the hub dial a node from its own IP, v4 or v6", () => {
        expect(hubRule(HUB)).toEqual({ port: 9420, from: "2001:db8::1/128" });
        expect(hubRule({ ...HUB, ip: "198.51.100.1" })).toEqual({ port: 9420, from: "198.51.100.1/32" });
    });

    it("makes a key pair: two raw 32-byte keys, base64", () => {
        const key = makeGridKey();

        expect(Buffer.from(key.private, "base64")).toHaveLength(32);
        expect(Buffer.from(key.public, "base64")).toHaveLength(32);
    });

    it("writes a node config without signal: no listen port, a cmd without a timeout", () => {
        const { script } = nodePart({ tags: ["a"], cmds: { go: { exec: ["go", "run"] } } }, HUB, "node-key");
        const line = script.find((one) => {
            return one.endsWith("> /etc/grid/node.toml");
        })!;

        const toml = Buffer.from(line.split("'")[1]!, "base64").toString();

        expect(toml).toContain('ip = "2001:db8::1"\ntrust');
        expect(toml).toContain('[cmds.go]\nexec = ["go", "run"]\n');
        expect(toml).not.toContain("signal");
        expect(script).toContain("echo 'node-key' > /etc/grid/node.key");
    });

    it("sets the node up before the kind's script, and starts it only after", () => {
        const { script, start } = nodePart({ tags: ["a"], cmds: { go: { exec: ["go"] } } }, HUB, "node-key");

        expect(script.at(-1)).toBe("systemctl daemon-reload");
        expect(start).toEqual(["systemctl enable --now grid-node"]);
    });

    it("takes a worker with cmds, each with an exec and a dur timeout, and signal only with listen", () => {
        const cmds = { make: { exec: ["make"], timeout: "10m" } };

        expect(checkWorker({ tags: ["a"], cmds, signal: false } as KindWorker, undefined)).toBeUndefined();
        expect(checkWorker({ tags: ["a"], cmds, signal: true } as KindWorker, 9500)).toBeUndefined();
    });

    it("refuses a worker that is not grid's: each key it checks, and why", () => {
        const refused: [unknown, string][] = [
            [{ tags: [], cmds: { a: { exec: ["a"] } }, image: "x" }, "image is not a key of grid's worker"],
            [{ tags: [] }, "cmds: at least one cmd"],
            [{ tags: [], cmds: [] }, "cmds: at least one cmd"],
            [{ tags: [], cmds: { Bad: { exec: ["a"] } } }, "cmds.Bad: a cmd, under a name"],
            [{ tags: [], cmds: { a: "make" } }, "cmds.a: a cmd, under a name"],
            [{ tags: [], cmds: { a: { exec: ["a"], user: "x" } } }, "cmds.a.user: not a key of a cmd"],
            [{ tags: [], cmds: { a: { exec: "make" } } }, "cmds.a.exec: a command line"],
            [{ tags: [], cmds: { a: { exec: [] } } }, "cmds.a.exec: a command line"],
            [{ tags: [], cmds: { a: { exec: ["make", 1] } } }, "cmds.a.exec: a command line"],
            [{ tags: [], cmds: { a: { exec: ["a"], timeout: 60 } } }, "cmds.a.timeout: not a dur"],
            [{ tags: [], cmds: { a: { exec: ["a"], timeout: "1 hour" } } }, "cmds.a.timeout: not a dur"],
            [{ tags: [], cmds: { a: { exec: ["a"] } }, signal: "yes" }, "signal: not a bool"],
        ];

        for (const [worker, message] of refused) {
            expect(() => {
                checkWorker(worker as KindWorker, 9500);
            }, message).toThrow(message);
        }
    });
});

describe("grid shares", () => {
    it("gives a path in the space, `.` for the space itself", () => {
        expect(spacePath(undefined)).toBe(".");
        expect(spacePath("a//b/")).toBe("a/b/");
    });

    it("passes over a push that is not a share, before and after one", () => {
        const steps = [{ cmd: "exec" }];

        expect(
            shareProblem({
                tag: "a",
                steps,
                push: [{ from: "/x", to: "src" }, { from: "/y", to: "lib", share: true }, { from: "/z" }],
            }),
        ).toBeNull();

        expect(shareProblem({ tag: "a", steps })).toBeNull();
    });
});
