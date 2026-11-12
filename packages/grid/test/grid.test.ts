import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { decodeCbor, encodeCbor } from "../src/cbor.js";
import { Initiator, keypairOf, Responder, type Transport } from "../src/noise.js";
import { shareProblem } from "../src/share.js";
import { TarStore } from "../src/tars.js";
import { frameOf } from "./fake-node.js";
import { hex } from "./helpers.js";

type Vectors = {
    prologue: string;
    initiator: { private: string; public: string; ephemeral: string };
    responder: { private: string; public: string; ephemeral: string };
    handshake: [string, string];
    transport: { from: "initiator" | "responder"; plain: string; frame: string }[];
    envelopes: { name: string; cbor: string }[];
};

const vectors = JSON.parse(readFileSync(new URL("./fixtures/grid-vectors.json", import.meta.url), "utf8")) as Vectors;

const base64 = (value: string): Buffer => {
    return Buffer.from(value, "base64");
};

/* A payload as it goes on the wire: `| u16 big-endian length | payload |`, in hex. */
function framed(payload: Buffer): string {
    return frameOf(payload).toString("hex");
}

function sides() {
    const initiator = keypairOf(base64(vectors.initiator.private));
    const responder = keypairOf(base64(vectors.responder.private));

    return {
        initiator: new Initiator(
            initiator,
            responder.public,
            vectors.prologue,
            keypairOf(hex(vectors.initiator.ephemeral)),
        ),
        responder: new Responder(responder, vectors.prologue, keypairOf(hex(vectors.responder.ephemeral))),
    };
}

describe("grid/2, by grid's own vectors", () => {
    it("derives the vector public keys", () => {
        expect(keypairOf(base64(vectors.initiator.private)).public.toString("base64")).toBe(vectors.initiator.public);
        expect(keypairOf(base64(vectors.responder.private)).public.toString("base64")).toBe(vectors.responder.public);
    });

    it("encodes every envelope to the vector bytes and back", () => {
        for (const envelope of vectors.envelopes) {
            expect(encodeCbor(decodeCbor(hex(envelope.cbor))).toString("hex"), envelope.name).toBe(envelope.cbor);
        }
    });

    it("matches the handshake and transport frames", () => {
        const { initiator, responder } = sides();
        const first = initiator.writeFirst();

        expect(framed(first)).toBe(vectors.handshake[0]);
        expect(responder.readFirst(first).toString("base64")).toBe(vectors.initiator.public);

        const [second, responderTransport] = responder.writeSecond();

        expect(framed(second)).toBe(vectors.handshake[1]);

        const transports: Record<string, Transport> = {
            initiator: initiator.readSecond(second),
            responder: responderTransport,
        };

        for (const message of vectors.transport) {
            const peer = transports[message.from === "initiator" ? "responder" : "initiator"]!;
            const sealed = transports[message.from]!.sender.encrypt(hex(message.plain));

            expect(framed(sealed)).toBe(message.frame);
            expect(peer.receiver.decrypt(sealed).toString("hex")).toBe(message.plain);
        }
    });
});

describe("grid files", () => {
    it("packs an input once while it does not change, and names it by its sha256", async () => {
        const folder = mkdtempSync(path.join(tmpdir(), "grid-store-test-"));
        const store = new TarStore(path.join(folder, "tars"));
        const source = mkdtempSync(path.join(folder, "source-"));

        writeFileSync(path.join(source, "rows.csv"), "a,b\n1,2\n");

        const first = await store.pack(source);
        const again = await store.pack(source);

        expect(again.sum).toBe(first.sum);
        expect(createHash("sha256").update(readFileSync(first.file)).digest("hex")).toBe(first.sum);
        expect(readdirSync(path.join(folder, "tars"))).toHaveLength(1);

        writeFileSync(path.join(source, "rows.csv"), "a,b\n1,3\n");
        utimesSync(path.join(source, "rows.csv"), new Date(), new Date(Date.now() + 5000));

        const changed = await store.pack(source);

        expect(changed.sum).not.toBe(first.sum);

        await store.release([first, again, changed]);
        rmSync(folder, { recursive: true, force: true });
    });

    it("gives a share push its own path: not the space, no push or pull at it or holding it", () => {
        const steps = [{ cmd: "exec" }];
        const share = { from: "/data", to: "datasets/a/entries", share: true };

        expect(shareProblem({ tag: "python", steps, push: [share], pull: [{ path: "out", into: "/x" }] })).toBeNull();
        expect(shareProblem({ tag: "python", steps, push: [{ ...share, to: "." }] })).toMatch(/not the space/);

        expect(
            shareProblem({ tag: "python", steps, push: [share, { from: "/y", to: "datasets/a/entries/import" }] }),
        ).toMatch(/is in push 1, a share/);

        expect(
            shareProblem({ tag: "python", steps, push: [share], pull: [{ path: "datasets/a", into: "/x" }] }),
        ).toMatch(/takes in push 1/);

        expect(shareProblem({ tag: "python", steps, push: [share], pull: [{ path: ".", into: "/x" }] })).toMatch(
            /takes in/,
        );
    });
});
