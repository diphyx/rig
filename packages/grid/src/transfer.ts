import { createReadStream } from "node:fs";
import { open, rm, stat } from "node:fs/promises";
import { isArray, isNumber, tryit } from "radash";

import { extractTar, hashFile } from "./tar.js";
import { GridClosed, GridReject, MAX_CHUNK } from "./wire.js";

import type { GridCall, GridConnection } from "./wire.js";

/* A pull that arrived whole but cannot be laid down here (a full disk, a refused entry): sending it again won't help. */
export class GridUnpacked extends Error {}

export class GridHalted extends Error {
    constructor() {
        super("killed");
    }
}

function asBuffer(value: unknown): Buffer | null {
    return value instanceof Uint8Array ? Buffer.from(value) : null;
}

async function sendFrom(started: GridCall, file: string, offset: number, signal?: AbortSignal) {
    for await (const chunk of createReadStream(file, { start: offset, highWaterMark: MAX_CHUNK })) {
        if (signal?.aborted) {
            await started.cancel();

            throw new GridHalted();
        }

        await started.data(chunk as Buffer);
    }
}

/* How a push went: the node had the share (no bytes sent), took it into its share, or into the space. */
export type PushHow = "hit" | "installed" | "normal";

/* spec §6 push: the node says how much it already has, or with an `id` (a share push, §10) that it has it all; the
   hub sends the rest and checks the whole against the tar's own sha256. */
export async function pushTar(
    connection: GridConnection,
    options: { job: string; to?: string; file: string; sum: string; id?: string; signal?: AbortSignal },
): Promise<PushHow> {
    const started = await connection.start("push", {
        job: options.job,
        ...(options.to ? { path: options.to } : {}),
        ...(options.id ? { id: options.id } : {}),
    });

    return (async (): Promise<PushHow> => {
        const first = await started.next();

        if (first.reject) {
            throw new GridReject(first.reject.reason, first.reject.message);
        }

        const offer = (first.data ?? {}) as { offset?: unknown; have?: unknown };
        const isHad = offer.have === true;

        if (!isHad) {
            await sendFrom(started, options.file, isNumber(offer.offset) ? offer.offset : 0, options.signal);
        }

        await started.end();

        const ok = await started.reply();

        if (asBuffer(ok.sha256)?.toString("hex") !== options.sum) {
            throw new Error("push: sha256 differs");
        }

        if (isHad) {
            return "hit";
        }

        return ok.share === true ? "installed" : "normal";
    })().finally(() => {
        return started.close();
    });
}

export interface PulledFile {
    path: string;
    size: number;
    modified: number;
}

async function receive(started: GridCall, part: string, signal?: AbortSignal): Promise<Buffer | null> {
    const handle = await open(part, "a");

    return (async () => {
        while (true) {
            if (signal?.aborted) {
                await started.cancel();

                throw new GridHalted();
            }

            const envelope = await started.next();

            if (envelope.reject) {
                throw new GridReject(envelope.reject.reason, envelope.reject.message);
            }

            const chunk = asBuffer(envelope.data);

            if (chunk) {
                await handle.write(chunk);
            }

            if (envelope.end) {
                return asBuffer(envelope.end.sha256);
            }
        }
    })().finally(() => {
        return handle.close();
    });
}

/* spec §6 pull: the partial stream stays on disk, so a broken pull resumes at its size. */
export async function pullTar(
    connection: GridConnection,
    options: { job: string; path: string; part: string; into: string; since?: number; signal?: AbortSignal },
): Promise<PulledFile[]> {
    const offset = await stat(options.part).then(
        (stats) => {
            return stats.size;
        },
        () => {
            return 0;
        },
    );

    const started = await connection.start("pull", {
        job: options.job,
        path: options.path,
        ...(options.since ? { since: options.since } : {}),
        ...(offset ? { offset } : {}),
    });

    return (async () => {
        const listed = await started.reply();
        const files = isArray(listed.files) ? (listed.files as unknown as PulledFile[]) : [];
        const sha256 = await receive(started, options.part, options.signal);

        if (!files.length) {
            await rm(options.part, { force: true });

            return files;
        }

        if (!sha256?.equals(await hashFile(options.part))) {
            await rm(options.part, { force: true });

            throw new GridClosed("pull: sha256 differs; it starts again");
        }

        const [unpackError] = await tryit(() => {
            return extractTar(options.part, options.into);
        })();

        await rm(options.part, { force: true });

        if (unpackError) {
            throw new GridUnpacked(`pull: ${unpackError.message}`);
        }

        return files;
    })().finally(() => {
        return started.close();
    });
}
