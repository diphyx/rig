import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { sleep } from "radash";

import { keypairOf, type Keypair } from "../src/noise.js";

/** The grid release a test's hub sets its machines up with. */
export const RELEASE = { version: "2.0.0", sha256: { arm: "a".repeat(64), x86: "b".repeat(64) } };

/** The bytes a hex string holds. */
export function hex(value: string): Buffer {
    return Buffer.from(value, "hex");
}

/** A random key pair, as `grid key new` makes one. */
export function randomPair(): Keypair {
    return keypairOf(randomBytes(32));
}

/** A hub key pair, raw and base64, as `grid key new` writes it. */
export function keys() {
    const pair = randomPair();

    return { pair, private: pair.private.toString("base64"), public: pair.public.toString("base64") };
}

/** A port nothing listens on, from the OS. */
export async function freePort(): Promise<number> {
    const server = createServer();

    await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
    });

    const { port } = server.address() as AddressInfo;

    await new Promise((resolve) => {
        server.close(resolve);
    });

    return port;
}

/** A new folder in the OS temp folder, its name starting with this prefix. */
export function tempFolder(prefix: string): string {
    return mkdtempSync(path.join(tmpdir(), prefix));
}

/** Waits for a condition, a few ms at a time; it fails the test when it never comes. */
export async function until(condition: () => boolean, limit = 5000) {
    for (let waited = 0; waited < limit && !condition(); waited += 5) {
        await sleep(5);
    }

    if (!condition()) {
        throw new Error("a condition never came");
    }
}
