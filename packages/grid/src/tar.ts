import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readdir, readlink, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { all, isEmpty, sum, tryit } from "radash";

import type { FileHandle } from "node:fs/promises";

const BLOCK = 512;
const USTAR_NAME = 100;
const OCTAL_SIZE_LIMIT = 0o77777777777;

export interface TarEntry {
    path: string;
    source: string;
    kind: "file" | "dir" | "link";
    size: number;
    mode: number;
    mtime: number;
    /* The mtime in ms, as precise as the disk keeps it: what a push's manifest is made of. */
    changed: number;
    link: string;
}

function isSafePath(value: string): boolean {
    const normal = path.posix.normalize(value);

    return !value.startsWith("/") && normal !== ".." && !normal.startsWith("../") && !value.includes("\0");
}

const TYPE_FLAGS = { file: "0", dir: "5", link: "2" } as const;

const MODES = { file: 0o755, dir: 0o755, link: 0o777 } as const;

function kindOf(stats: Awaited<ReturnType<typeof lstat>>): TarEntry["kind"] {
    if (stats.isDirectory()) {
        return "dir";
    }

    return stats.isSymbolicLink() ? "link" : "file";
}

function entryOf(relative: string, source: string, stats: Awaited<ReturnType<typeof lstat>>, link = ""): TarEntry {
    const kind = kindOf(stats);
    const isPlainFile = kind === "file" && (Number(stats.mode) & 0o111) === 0;

    return {
        path: relative,
        source,
        kind,
        size: kind === "file" ? Number(stats.size) : 0,
        mode: isPlainFile ? 0o644 : MODES[kind],
        mtime: Math.floor(Number(stats.mtimeMs) / 1000),
        changed: Number(stats.mtimeMs),
        link,
    };
}

async function walk(root: string, relative: string): Promise<TarEntry[]> {
    const source = path.join(root, relative);
    const stats = await lstat(source);

    if (stats.isSymbolicLink()) {
        return [entryOf(relative, source, stats, await readlink(source))];
    }

    if (!stats.isDirectory()) {
        return stats.isFile() ? [entryOf(relative, source, stats)] : [];
    }

    const names = await readdir(source);
    const nested = await all(
        names.map((name) => {
            return walk(root, relative ? `${relative}/${name}` : name);
        }),
    );

    return [...(relative ? [entryOf(relative, source, stats)] : []), ...nested.flat()];
}

export async function hashFile(file: string): Promise<Buffer> {
    const hash = createHash("sha256");

    for await (const chunk of createReadStream(file)) {
        hash.update(chunk as Buffer);
    }

    return hash.digest();
}

/* A file is packed under its own name; a folder by its contents, so it lands at the push `path`. */
export async function collectEntries(from: string): Promise<TarEntry[]> {
    const stats = await lstat(from);
    const entries = stats.isDirectory() ? await walk(from, "") : await walk(path.dirname(from), path.basename(from));

    return entries.sort((left, right) => {
        return Buffer.compare(Buffer.from(left.path), Buffer.from(right.path));
    });
}

function octal(value: number, width: number): string {
    return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function paxRecord(key: string, value: string): string {
    const body = ` ${key}=${value}\n`;
    let length = Buffer.byteLength(body) + 1;

    while (String(length).length + Buffer.byteLength(body) !== length) {
        length = String(length).length + Buffer.byteLength(body);
    }

    return `${length}${body}`;
}

function header(name: string, size: number, mode: number, mtime: number, type: string, link = ""): Buffer {
    const block = Buffer.alloc(BLOCK);

    block.write(name, 0, USTAR_NAME, "utf8");
    block.write(octal(mode, 8), 100, "ascii");
    block.write(octal(0, 8), 108, "ascii");
    block.write(octal(0, 8), 116, "ascii");
    block.write(octal(size, 12), 124, "ascii");
    block.write(octal(mtime, 12), 136, "ascii");
    block.write("        ", 148, "ascii");
    block.write(type, 156, "ascii");
    block.write(link, 157, USTAR_NAME, "utf8");
    block.write("ustar\u000000", 257, "ascii");
    block.write(octal(0, 8), 329, "ascii");
    block.write(octal(0, 8), 337, "ascii");

    const checksum = sum([...block]);
    block.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");

    return block;
}

function padding(size: number): Buffer {
    return Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);
}

/* PAX records only when ustar cannot hold a field: a long name or link, a size past 8 GiB. */
function headersOf(entry: TarEntry): Buffer[] {
    const name = entry.kind === "dir" ? `${entry.path}/` : entry.path;
    const type = TYPE_FLAGS[entry.kind];

    const records = [
        Buffer.byteLength(name) > USTAR_NAME ? paxRecord("path", name) : "",
        Buffer.byteLength(entry.link) > USTAR_NAME ? paxRecord("linkpath", entry.link) : "",
        entry.size > OCTAL_SIZE_LIMIT ? paxRecord("size", String(entry.size)) : "",
    ].join("");

    const main = header(name, Math.min(entry.size, OCTAL_SIZE_LIMIT), entry.mode, entry.mtime, type, entry.link);

    if (isEmpty(records)) {
        return [main];
    }

    const pax = Buffer.from(records, "utf8");

    return [
        header(`PaxHeaders/${entry.path}`.slice(0, USTAR_NAME), pax.length, 0o644, entry.mtime, "x"),
        pax,
        padding(pax.length),
        main,
    ];
}

async function writeAll(handle: FileHandle, buffer: Buffer) {
    if (buffer.length) {
        await handle.write(buffer);
    }
}

async function copyInto(handle: FileHandle, entry: TarEntry) {
    let written = 0;

    for await (const chunk of createReadStream(entry.source)) {
        const part = (chunk as Buffer).subarray(0, entry.size - written);
        await writeAll(handle, part);
        written += part.length;
    }

    if (written !== entry.size) {
        throw new Error(`tar: ${entry.path} changed while packing`);
    }

    await writeAll(handle, padding(entry.size));
}

/* The same files give the same bytes (spec §10), so a broken push resumes at the node's offset. */
export async function packTar(entries: TarEntry[], target: string) {
    const handle = await open(target, "w");

    await (async () => {
        for (const entry of entries) {
            for (const block of headersOf(entry)) {
                await writeAll(handle, block);
            }

            if (entry.kind === "file") {
                await copyInto(handle, entry);
            }
        }

        await writeAll(handle, Buffer.alloc(BLOCK * 2));
    })().finally(() => {
        return handle.close();
    });
}

function field(block: Buffer, start: number, length: number): string {
    const raw = block.subarray(start, start + length);
    const end = raw.indexOf(0);

    return raw.subarray(0, end === -1 ? length : end).toString("utf8");
}

function number(block: Buffer, start: number, length: number): number {
    const raw = block.subarray(start, start + length);

    /* Base-256 for values octal cannot hold. */
    if (raw[0]! & 0x80) {
        return raw.subarray(1).reduce((value, byte) => {
            return value * 256 + byte;
        }, raw[0]! & 0x7f);
    }

    const text = field(block, start, length).trim();

    return text ? Number.parseInt(text, 8) : 0;
}

function ustarName(block: Buffer): string {
    const prefix = field(block, 345, 155);
    const name = field(block, 0, 100);

    return prefix ? `${prefix}/${name}` : name;
}

function parsePax(body: Buffer): Record<string, string> {
    const records: Record<string, string> = {};
    let offset = 0;

    while (offset < body.length) {
        const space = body.indexOf(0x20, offset);
        const length = Number.parseInt(body.subarray(offset, space).toString("ascii"), 10);

        if (!length || space === -1) {
            break;
        }

        const record = body.subarray(space + 1, offset + length - 1).toString("utf8");
        const equals = record.indexOf("=");
        records[record.slice(0, equals)] = record.slice(equals + 1);
        offset += length;
    }

    return records;
}

async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);

    return buffer.subarray(0, bytesRead);
}

/* What a pull lands on may be there from the last one: a file or a link is replaced, never written through. */
async function clear(target: string) {
    const [, stats] = await tryit(() => {
        return lstat(target);
    })();

    if (stats && !stats.isDirectory()) {
        await rm(target, { force: true });
    }
}

async function extractFile(handle: FileHandle, position: number, size: number, target: string, mode: number) {
    await mkdir(path.dirname(target), { recursive: true });
    await clear(target);
    const output = await open(target, "w", mode & 0o111 ? 0o755 : 0o644);

    await (async () => {
        for (let done = 0; done < size;) {
            const chunk = await readAt(handle, position + done, Math.min(size - done, 1 << 20));

            if (!chunk.length) {
                throw new Error("tar: truncated file");
            }

            await output.write(chunk);
            done += chunk.length;
        }
    })().finally(() => {
        return output.close();
    });
}

function checkLink(name: string, link: string) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(name), link));

    if (link.startsWith("/") || target === ".." || target.startsWith("../")) {
        throw new Error(`tar: symlink ${name} leaves the folder`);
    }
}

/* Reads the node's tar into a folder, entry by entry, refusing anything that would leave it. */
export async function extractTar(source: string, folder: string): Promise<string[]> {
    const handle = await open(source, "r");
    const written: string[] = [];

    await (async () => {
        let position = 0;
        let pax: Record<string, string> = {};

        while (true) {
            const block = await readAt(handle, position, BLOCK);

            if (
                block.length < BLOCK ||
                block.every((byte) => {
                    return byte === 0;
                })
            ) {
                return;
            }

            const type = field(block, 156, 1) || "0";
            const size = Number(pax.size ?? number(block, 124, 12));
            const name = (pax.path ?? ustarName(block)).replace(/\/+$/, "");
            const link = pax.linkpath ?? field(block, 157, 100);
            const body = position + BLOCK;
            position = body + size + padding(size).length;

            if (type === "x" || type === "g") {
                pax = type === "x" ? parsePax(await readAt(handle, body, size)) : pax;
                continue;
            }

            pax = {};

            if (!isSafePath(name)) {
                throw new Error(`tar: path ${name} leaves the folder`);
            }

            const target = path.join(folder, name);

            if (type === "5") {
                await mkdir(target, { recursive: true });
            } else if (type === "2") {
                checkLink(name, link);
                await mkdir(path.dirname(target), { recursive: true });
                await clear(target);
                await symlink(link, target);
            } else if (type === "0") {
                await extractFile(handle, body, size, target, number(block, 100, 8));
                written.push(name);
            } else {
                throw new Error(`tar: entry ${name} of type ${type} is not allowed`);
            }
        }
    })().finally(() => {
        return handle.close();
    });

    return written;
}
