import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import path from "node:path";
import { tryit } from "radash";

import { collectEntries, hashFile, packTar } from "./tar.js";

import type { TarEntry } from "./tar.js";

/* A tar no job holds stays this long after its last use, so the next job with the same input finds it packed. */
const TAR_KEEP_MS = 60 * 60 * 1000;

export interface PackedPush {
    sum: string;
    file: string;
}

/* The key of a push source: its absolute path and every entry's path, kind, size, mtime, mode and link. Only the
   folder is walked, no file is read; the same key is the same tar, unless a file changed keeping its size and mtime. */
function manifestOf(from: string, entries: TarEntry[]): string {
    const hash = createHash("sha256");

    hash.update(`${path.resolve(from)}\n`);

    for (const entry of entries) {
        hash.update(`${entry.path}\0${entry.kind}\0${entry.size}\0${entry.changed}\0${entry.mode}\0${entry.link}\n`);
    }

    return hash.digest("hex");
}

/* Every push the hub sends, packed once per content and named by its sha256: the same input is packed again only
   when it changed, whichever jobs push it. A tar is held while a job uses it, and swept an hour after. */
export class TarStore {
    private readonly sums = new Map<string, string>();
    private readonly packing = new Map<string, Promise<string>>();
    private readonly holds = new Map<string, number>();

    constructor(private readonly folder: string) {}

    private fileOf(sum: string): string {
        return path.join(this.folder, `${sum}.tar`);
    }

    /* The tar of a local file or folder, held until `release`. */
    async pack(from: string): Promise<PackedPush> {
        const entries = await collectEntries(from);
        const manifest = manifestOf(from, entries);
        const sum = (await this.known(manifest)) ?? (await this.packOnce(manifest, entries));

        this.holds.set(sum, (this.holds.get(sum) ?? 0) + 1);

        return { sum, file: this.fileOf(sum) };
    }

    async release(packed: PackedPush[]) {
        for (const { sum, file } of packed) {
            const holds = (this.holds.get(sum) ?? 1) - 1;

            if (holds > 0) {
                this.holds.set(sum, holds);
            } else {
                this.holds.delete(sum);
            }

            await this.touch(file);
        }
    }

    private async touch(file: string): Promise<boolean> {
        const now = new Date();
        const [problem] = await tryit(() => {
            return utimes(file, now, now);
        })();

        return !problem;
    }

    /* A tar packed before from the same manifest, still on disk; it counts as used now, so no sweep takes it. */
    private async known(manifest: string): Promise<string | null> {
        const sum = this.sums.get(manifest);

        if (sum && (await this.touch(this.fileOf(sum)))) {
            return sum;
        }

        this.sums.delete(manifest);

        return null;
    }

    /* Two jobs pushing the same new input at once pack it once. */
    private packOnce(manifest: string, entries: TarEntry[]): Promise<string> {
        const pending =
            this.packing.get(manifest) ??
            this.write(entries)
                .then((sum) => {
                    this.sums.set(manifest, sum);

                    return sum;
                })
                .finally(() => {
                    return this.packing.delete(manifest);
                });

        this.packing.set(manifest, pending);

        return pending;
    }

    private async write(entries: TarEntry[]): Promise<string> {
        await mkdir(this.folder, { recursive: true });

        const temporary = path.join(this.folder, `.tmp-${randomUUID()}`);

        const [problem, sum] = await tryit(async () => {
            await packTar(entries, temporary);

            const hashed = (await hashFile(temporary)).toString("hex");
            await rename(temporary, this.fileOf(hashed));

            return hashed;
        })();

        if (problem) {
            await rm(temporary, { force: true });

            throw problem;
        }

        void this.sweep();

        return sum;
    }

    /* The tars no job holds, unused for an hour, and what was left of a pack that broke; a manifest pointing at a swept
       tar is forgotten when it is next looked up. */
    private async sweep() {
        const [, names] = await tryit(() => {
            return readdir(this.folder);
        })();

        const held = new Set(
            [...this.holds.keys()].map((sum) => {
                return `${sum}.tar`;
            }),
        );

        for (const name of names ?? []) {
            const file = path.join(this.folder, name);
            const [, stats] = await tryit(() => {
                return stat(file);
            })();

            if (!stats || held.has(name) || Date.now() - stats.mtimeMs < TAR_KEEP_MS) {
                continue;
            }

            await rm(file, { force: true });
        }
    }
}
