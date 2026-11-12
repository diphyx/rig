import { execFileSync } from "node:child_process";

import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    rmSync,
    statSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from "node:fs";

import path from "node:path";

import { all, sleep } from "radash";
import { afterEach, describe, expect, it } from "vitest";

import { collectEntries, extractTar, packTar, type TarEntry } from "../src/tar.js";
import { TarStore } from "../src/tars.js";
import { tempFolder } from "./helpers.js";

const folders: string[] = [];

/* A temp folder, removed after each test. */
function folder(): string {
    const made = tempFolder("grid-tar-test-");

    folders.push(made);

    return made;
}

afterEach(() => {
    for (const one of folders.splice(0)) {
        chmodSync(one, 0o755);
        rmSync(one, { recursive: true, force: true });
    }
});

/* One tar header, by hand: its name, type, size and link; the prefix field and a base-256 size when asked. */
function header(
    name: string,
    options: { type?: string; size?: number; link?: string; prefix?: string; binarySize?: boolean; mode?: string } = {},
): Buffer {
    const block = Buffer.alloc(512);

    block.write(name, 0, 100, "utf8");
    block.write(options.mode ?? "0000644\0", 100, "ascii");

    if (options.binarySize) {
        block[124] = 0x80;
        block.writeUInt32BE(options.size ?? 0, 124 + 8);
    } else if (options.size !== undefined) {
        block.write(`${options.size.toString(8).padStart(11, "0")}\0`, 124, "ascii");
    }

    block.write(options.type ?? "0", 156, "ascii");
    block.write(options.link ?? "", 157, 100, "utf8");
    block.write(options.prefix ?? "", 345, 155, "utf8");

    return block;
}

/* A body padded to its 512-byte blocks. */
function body(text: string): Buffer {
    const bytes = Buffer.from(text);

    return Buffer.concat([bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)]);
}

/* A pax record, its length counting itself. */
function record(key: string, value: string): string {
    const line = ` ${key}=${value}\n`;
    let length = line.length + 1;

    while (String(length).length + line.length !== length) {
        length = String(length).length + line.length;
    }

    return `${length}${line}`;
}

function tarFile(base: string, ...blocks: Buffer[]): string {
    const file = path.join(base, "made.tar");

    writeFileSync(file, Buffer.concat([...blocks, Buffer.alloc(1024)]));

    return file;
}

describe("tar", () => {
    it("packs files, folders, modes and links, and lays them down again the same", async () => {
        const base = folder();
        const source = path.join(base, "source");
        const into = path.join(base, "into");
        const long = "n".repeat(120);

        mkdirSync(path.join(source, "bin"), { recursive: true });
        mkdirSync(path.join(source, "empty"));
        writeFileSync(path.join(source, "rows.csv"), "a,b\n");
        writeFileSync(path.join(source, "bin", "run.sh"), "echo hi\n");
        chmodSync(path.join(source, "bin", "run.sh"), 0o755);
        writeFileSync(path.join(source, `${long}.txt`), "long\n");
        symlinkSync("rows.csv", path.join(source, "rows-link"));
        symlinkSync(`${"l".repeat(110)}/../rows.csv`, path.join(source, "long-link"));

        const entries = await collectEntries(source);

        expect(
            entries.map((entry) => {
                return [entry.path, entry.kind, entry.mode.toString(8)];
            }),
        ).toEqual([
            ["bin", "dir", "755"],
            ["bin/run.sh", "file", "755"],
            ["empty", "dir", "755"],
            ["long-link", "link", "777"],
            [`${long}.txt`, "file", "644"],
            ["rows-link", "link", "777"],
            ["rows.csv", "file", "644"],
        ]);

        const tar = path.join(base, "out.tar");

        await packTar(entries, tar);

        /* What a pull lands on may be there already: a file and a link are replaced. */
        mkdirSync(into);
        writeFileSync(path.join(into, "rows.csv"), "old\n");
        symlinkSync("elsewhere", path.join(into, "rows-link"));

        const written = await extractTar(tar, into);

        expect(written.sort()).toEqual(["bin/run.sh", `${long}.txt`, "rows.csv"].sort());
        expect(readFileSync(path.join(into, "rows.csv"), "utf8")).toBe("a,b\n");
        expect(readFileSync(path.join(into, `${long}.txt`), "utf8")).toBe("long\n");
        expect(statSync(path.join(into, "bin", "run.sh")).mode & 0o777).toBe(0o755);
        expect(statSync(path.join(into, "rows.csv")).mode & 0o777).toBe(0o644);
        expect(readlinkSync(path.join(into, "rows-link"))).toBe("rows.csv");
        expect(readlinkSync(path.join(into, "long-link"))).toBe(`${"l".repeat(110)}/../rows.csv`);
        expect(lstatSync(path.join(into, "empty")).isDirectory()).toBe(true);
    });

    it("packs a single file under its own name, and leaves out what is neither file, folder nor link", async () => {
        const base = folder();

        writeFileSync(path.join(base, "one.txt"), "1");
        execFileSync("mkfifo", [path.join(base, "pipe")]);

        expect(await collectEntries(path.join(base, "one.txt"))).toMatchObject([{ path: "one.txt", kind: "file" }]);

        expect(
            (await collectEntries(base)).map((entry) => {
                return entry.path;
            }),
        ).toEqual(["one.txt"]);
    });

    it("refuses a file that changed while packing, and gives a size past ustar's a pax record", async () => {
        const base = folder();
        const source = path.join(base, "small.txt");

        writeFileSync(source, "abc");

        const entry: TarEntry = {
            path: "small.txt",
            source,
            kind: "file",
            size: 0o77777777777 + 1,
            mode: 0o644,
            mtime: 0,
            changed: 0,
            link: "",
        };

        await expect(packTar([entry], path.join(base, "big.tar"))).rejects.toThrow("small.txt changed while packing");
        expect(readFileSync(path.join(base, "big.tar")).subarray(512).toString()).toContain(" size=8589934592\n");
    });

    it("reads a prefix name, a base-256 size, a global header and an empty type as a file", async () => {
        const base = folder();
        const into = path.join(base, "into");

        const file = tarFile(
            base,
            header("pax_global", { type: "g", size: 512 }),
            body(record("comment", "skipped")),
            header("deep.txt", { prefix: "a/b", size: 3, binarySize: true, type: "\0", mode: "\0" }),
            body("abc"),
        );

        expect(await extractTar(file, into)).toEqual(["a/b/deep.txt"]);
        expect(readFileSync(path.join(into, "a", "b", "deep.txt"), "utf8")).toBe("abc");
        expect(statSync(path.join(into, "a", "b", "deep.txt")).mode & 0o777).toBe(0o644);
    });

    it("stops at a pax record it cannot read, and at a tar that ends without its zero blocks", async () => {
        const base = folder();
        const into = path.join(base, "into");
        const records = "x".repeat(10);

        const file = path.join(base, "short.tar");

        writeFileSync(
            file,
            Buffer.concat([
                header("pax", { type: "x", size: records.length }),
                body(records),
                header("a.txt", { size: 0 }),
            ]),
        );

        expect(await extractTar(file, into)).toEqual(["a.txt"]);

        writeFileSync(file, header("b.txt", { size: 0 }).subarray(0, 100));
        expect(await extractTar(file, into)).toEqual([]);
    });

    it("refuses an entry that leaves the folder, a link out of it, a type it does not take, and a cut file", async () => {
        const base = folder();
        const into = path.join(base, "into");

        const refused: [Buffer[], string][] = [
            [[header("/etc/passwd")], "path /etc/passwd leaves the folder"],
            [[header("../up")], "path ../up leaves the folder"],
            [[header("..")], "path .. leaves the folder"],
            [[header("x", { type: "x", size: 512 }), body(record("path", "a\0b")), header("x")], "leaves the folder"],
            [[header("in", { type: "2", link: "/etc" })], "symlink in leaves the folder"],
            [[header("in", { type: "2", link: "../.." })], "symlink in leaves the folder"],
            [[header("dev", { type: "3" })], "entry dev of type 3 is not allowed"],
        ];

        for (const [blocks, message] of refused) {
            await expect(extractTar(tarFile(base, ...blocks), into), message).rejects.toThrow(message);
        }

        const cut = path.join(base, "cut.tar");

        writeFileSync(cut, Buffer.concat([header("cut.txt", { size: 2000 }), Buffer.from("abc")]));
        await expect(extractTar(cut, into)).rejects.toThrow("truncated file");
    });
});

describe("tar store", () => {
    it("packs the same new input once when two jobs push it at once, and holds it for each", async () => {
        const base = folder();
        const store = new TarStore(path.join(base, "tars"));

        writeFileSync(path.join(base, "in.txt"), "x");

        const [first, second] = await all([
            store.pack(path.join(base, "in.txt")),
            store.pack(path.join(base, "in.txt")),
        ]);

        expect(second).toEqual(first);
        await store.release([first]);
        await store.release([second, second]);
    });

    it("packs again when its tar is gone, and removes what is left of a pack that broke", async () => {
        const base = folder();
        const tars = path.join(base, "tars");
        const store = new TarStore(tars);
        const source = path.join(base, "source");

        mkdirSync(source);
        writeFileSync(path.join(source, "in.txt"), "x");

        const first = await store.pack(source);

        rmSync(first.file);

        const again = await store.pack(source);

        expect(again.sum).toBe(first.sum);
        expect(existsSync(again.file)).toBe(true);

        writeFileSync(path.join(source, "locked.txt"), "y");
        chmodSync(path.join(source, "locked.txt"), 0o000);

        await expect(store.pack(source)).rejects.toThrow();

        expect(
            readdirSync(tars).filter((name) => {
                return name.startsWith(".tmp-");
            }),
        ).toEqual([]);

        chmodSync(path.join(source, "locked.txt"), 0o644);
    });

    it("sweeps a tar unused for an hour once it packs another", async () => {
        const base = folder();
        const tars = path.join(base, "tars");
        const store = new TarStore(tars);
        const old = path.join(tars, `${"0".repeat(64)}.tar`);

        mkdirSync(tars);
        writeFileSync(old, "old");
        utimesSync(old, new Date(Date.now() - 2 * 3600_000), new Date(Date.now() - 2 * 3600_000));
        writeFileSync(path.join(base, "in.txt"), "x");

        const packed = await store.pack(path.join(base, "in.txt"));

        for (let waited = 0; waited < 2000 && existsSync(old); waited += 10) {
            await sleep(10);
        }

        expect(existsSync(old)).toBe(false);
        expect(existsSync(packed.file)).toBe(true);
    });
});
