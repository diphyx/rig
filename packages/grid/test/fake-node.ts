import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo, type Socket } from "node:net";
import path from "node:path";

import { all, isNumber } from "radash";
import { afterEach } from "vitest";

import { JobBook } from "../src/book.js";
import { decodeCbor, encodeCbor, type CborValue } from "../src/cbor.js";
import { GridHub } from "../src/hub.js";
import { Responder, type Transport } from "../src/noise.js";
import { collectEntries, packTar } from "../src/tar.js";
import { Inbox, type CborMap, type Envelope, type RejectReason } from "../src/wire.js";
import { randomPair, tempFolder } from "./helpers.js";

/** A frame: `| u16 big-endian length | payload |`. */
export function frameOf(payload: Buffer): Buffer {
    const head = Buffer.alloc(2);

    head.writeUInt16BE(payload.length);

    return Buffer.concat([head, payload]);
}

/** The sha256 of these bytes. */
export function sha256(data: Buffer): Buffer {
    return createHash("sha256").update(data).digest();
}

/** The bytes of a tar of these files, packed as the hub packs one. */
export async function tarOf(files: Record<string, string>): Promise<Buffer> {
    const folder = tempFolder("grid-fake-tar-");
    const source = path.join(folder, "source");

    for (const [name, text] of Object.entries(files)) {
        const file = path.join(source, name);

        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, text);
    }

    const target = path.join(folder, "out.tar");

    await packTar(await collectEntries(source), target);
    const bytes = readFileSync(target);

    rmSync(folder, { recursive: true, force: true });

    return bytes;
}

/** One call the hub made on the node, and the node's side of it. */
export class NodeCall {
    constructor(
        readonly id: number,
        readonly call: string,
        readonly body: CborMap,
        readonly inbox: Inbox,
        readonly connection: FakeConnection,
    ) {}

    ok(body: CborMap = {}) {
        this.connection.send({ id: this.id, ok: body });
    }

    reject(reason: RejectReason, message?: string) {
        this.connection.send({ id: this.id, reject: { reason, ...(message ? { message } : {}) } });
    }

    data(value: CborValue) {
        this.connection.send({ id: this.id, data: value });
    }

    end(value: CborMap = {}) {
        this.connection.send({ id: this.id, end: value });
    }

    next(): Promise<Envelope> {
        return this.inbox.next();
    }
}

/** One connection the hub dialed: its transport, once the handshake is done. */
export class FakeConnection {
    private transport: Transport | null = null;
    private pending = Buffer.alloc(0);
    private readonly responder: Responder;
    readonly inboxes = new Map<number, Inbox>();

    constructor(
        readonly socket: Socket,
        private readonly node: FakeNode,
    ) {
        this.responder = new Responder(node.pair, "grid/2");

        socket.on("data", (chunk: Buffer) => {
            this.receive(chunk);
        });

        socket.on("error", () => {
            return null;
        });

        socket.on("close", () => {
            node.connections.delete(this);

            for (const inbox of this.inboxes.values()) {
                inbox.close(new Error("node connection closed"));
            }
        });
    }

    private receive(chunk: Buffer) {
        this.pending = Buffer.concat([this.pending, chunk]);

        while (this.pending.length >= 2 && this.pending.length >= 2 + this.pending.readUInt16BE(0)) {
            const length = this.pending.readUInt16BE(0);
            const payload = Buffer.from(this.pending.subarray(2, 2 + length));

            this.pending = this.pending.subarray(2 + length);
            this.frame(payload);
        }
    }

    private frame(payload: Buffer) {
        if (!this.transport) {
            this.responder.readFirst(payload);

            const [second, transport] = this.responder.writeSecond();

            this.transport = transport;
            this.socket.write(frameOf(second));

            return;
        }

        const envelope = decodeCbor(this.transport.receiver.decrypt(payload)) as Envelope;

        this.node.received.push(envelope);

        if (envelope.ping) {
            if (!this.node.isSilent) {
                this.send({ pong: {} });
            }

            return;
        }

        if (envelope.call !== undefined && envelope.id) {
            const inbox = new Inbox();

            this.inboxes.set(envelope.id, inbox);
            this.node.answer(new NodeCall(envelope.id, envelope.call, envelope.body ?? {}, inbox, this));

            return;
        }

        if (envelope.id) {
            this.inboxes.get(envelope.id)?.put(envelope);
        }
    }

    /* An envelope to the hub, sealed in order. */
    send(envelope: Envelope) {
        this.sendValue(envelope as CborMap);
    }

    /* Any value to the hub, sealed in order: an envelope or not. */
    sendValue(value: CborValue) {
        this.raw(this.transport!.sender.encrypt(encodeCbor(value)));
    }

    /* An envelope's frame, sealed, for the test to write as it likes. */
    frameFor(envelope: Envelope): Buffer {
        return frameOf(this.transport!.sender.encrypt(encodeCbor(envelope as CborMap)));
    }

    /* A payload to the hub as it is, in its frame. */
    raw(payload: Buffer) {
        if (!this.socket.destroyed) {
            this.socket.write(frameOf(payload));
        }
    }
}

/** A node's answer to one call. */
export type Handler = (call: NodeCall) => void | Promise<void>;

/* A job on the fake node: its events so far, and the tails that follow them. */
type FakeJob = { events: CborMap[]; tails: Set<(event: CborMap) => void>; cmd: string };

/** A grid node in the test's own process: grid/2 over TCP, each call answered by its handlers. */
export class FakeNode {
    readonly pair = randomPair();
    readonly connections = new Set<FakeConnection>();
    readonly received: Envelope[] = [];
    readonly jobs = new Map<string, FakeJob>();
    /* What a pull of each path sends: its listed files and its tar. */
    readonly pulls = new Map<string, { files: CborMap[]; tar: Buffer }>();
    /* What each push brought, by its job. */
    readonly pushed: Buffer[] = [];
    handlers: Record<string, Handler> = {};
    port = 0;
    /* A node that answers no ping. */
    isSilent = false;
    private opened = 0;

    private readonly server = createServer((socket) => {
        this.connections.add(new FakeConnection(socket, this));
    });

    constructor() {
        this.handlers = {
            open: (call) => {
                this.opened += 1;
                const job = `j${this.opened}`;

                this.jobs.set(job, { events: [], tails: new Set(), cmd: "" });
                call.ok({ job });
            },
            push: async (call) => {
                call.data({ offset: 0 });
                const bytes = await this.collect(call);

                this.pushed.push(bytes);
                call.ok({ sha256: sha256(bytes) });
            },
            exec: (call) => {
                call.ok();
                this.run(String(call.body.job), String(call.body.cmd), "done");
            },
            tail: (call) => {
                return this.tail(call);
            },
            stat: (call) => {
                call.ok({ state: "exited" });
            },
            kill: (call) => {
                const job = this.jobOf(call);

                call.ok();
                this.emit(String(call.body.job), "state", { state: "stopped", cmd: job.cmd, message: "killed" });
            },
            drop: (call) => {
                call.ok();
            },
            pull: (call) => {
                const pull = this.pulls.get(String(call.body.path)) ?? { files: [], tar: Buffer.alloc(0) };

                this.sendPull(call, pull.files, pull.tar);
            },
        };
    }

    /* The key the hub trusts it by. */
    get key(): Buffer {
        return this.pair.public;
    }

    get address(): string {
        return `127.0.0.1:${this.port}`;
    }

    /* Its one connection from the hub, once the hub dialed. */
    get connection(): FakeConnection {
        return [...this.connections][0]!;
    }

    entry(name: string, tags: string[] = ["build"], share = false) {
        return { name, tags, ip: "127.0.0.1", port: this.port, trust: this.key, share };
    }

    calls(name: string): Envelope[] {
        return this.received.filter((envelope) => {
            return envelope.call === name;
        });
    }

    async start(): Promise<this> {
        await new Promise<void>((resolve) => {
            this.server.listen(0, "127.0.0.1", resolve);
        });

        this.port = (this.server.address() as AddressInfo).port;

        return this;
    }

    async stop() {
        for (const connection of this.connections) {
            connection.socket.destroy();
        }

        await new Promise<void>((resolve) => {
            this.server.close(() => {
                resolve();
            });
        });
    }

    /* Every connection the hub dialed, closed: a node that dropped off. */
    cut() {
        for (const connection of this.connections) {
            connection.socket.destroy();
        }
    }

    answer(call: NodeCall) {
        const handler = this.handlers[call.call];

        if (!handler) {
            call.reject("unknown", `no call ${call.call}`);

            return;
        }

        void (async () => {
            return handler(call);
        })().catch(() => {
            return null;
        });
    }

    jobOf(call: NodeCall): FakeJob {
        const name = String(call.body.job);
        const job = this.jobs.get(name) ?? { events: [], tails: new Set(), cmd: "" };

        this.jobs.set(name, job);

        return job;
    }

    /* A node event for the job, to every tail that follows it. */
    emit(name: string, type: string, data: CborValue) {
        const job = this.jobs.get(name) ?? { events: [], tails: new Set(), cmd: "" };

        this.jobs.set(name, job);
        const event = { seq: job.events.length + 1, time: Date.now(), type, data };

        job.events.push(event);

        for (const tail of job.tails) {
            tail(event);
        }
    }

    /* A cmd runs and ends in this state. */
    run(name: string, cmd: string, state: string, message = "") {
        const job = this.jobs.get(name);

        if (job) {
            job.cmd = cmd;
        }

        this.emit(name, "state", { state: "running", cmd, message: "" });

        if (state !== "running") {
            this.emit(name, "state", { state, cmd, message });
        }
    }

    /* A tail: its answer, these items first, then the job's events after the hub's last, and each new one. */
    async tail(call: NodeCall, first: CborValue[] = []) {
        const job = this.jobOf(call);
        const after = isNumber(call.body.after) ? call.body.after : 0;

        const send = (event: CborMap) => {
            call.data(event);
        };

        call.ok();

        for (const item of first) {
            call.data(item);
        }

        for (const event of job.events.slice(after)) {
            send(event);
        }

        job.tails.add(send);

        await call.next().catch(() => {
            return null;
        });

        job.tails.delete(send);
    }

    /* The data a push sends, until its end. */
    async collect(call: NodeCall): Promise<Buffer> {
        const chunks: Buffer[] = [];

        while (true) {
            const envelope = await call.next();

            if (envelope.data instanceof Uint8Array) {
                chunks.push(Buffer.from(envelope.data));
            }

            if (envelope.end) {
                return Buffer.concat(chunks);
            }
        }
    }

    /* A pull's answer: its files, then the tar from the hub's offset, in chunks, and its sha256. */
    sendPull(call: NodeCall, files: CborMap[], tar: Buffer, sum: Buffer = sha256(tar)) {
        const offset = isNumber(call.body.offset) ? call.body.offset : 0;

        call.ok({ files });

        for (let at = offset; at < tar.length; at += 1000) {
            call.data(tar.subarray(at, at + 1000));
        }

        call.end({ sha256: sum });
    }
}

/** A hub on fake nodes, with its own tars folder and its lines; `close` ends all of it. */
export async function hubOn(count: number) {
    const nodes = await all(
        Array.from({ length: count }, () => {
            return new FakeNode().start();
        }),
    );

    const folder = tempFolder("grid-hub-test-");
    const lines: string[] = [];
    const book = new JobBook();

    const hub = new GridHub(randomPair(), {
        book,
        tars: path.join(folder, "tars"),
        log: (line) => {
            lines.push(line);
        },
    });

    for (const [index, node] of nodes.entries()) {
        hub.add(node.entry(`m${index + 1}`));
    }

    const close = async () => {
        hub.close();

        for (const node of nodes) {
            await node.stop();
        }

        rmSync(folder, { recursive: true, force: true });
    };

    return { hub, book, nodes, node: nodes[0]!, folder, lines, close };
}

/** A hub on fake nodes for each test that asks, by `setUp`; it and each of `closers` closed after its test. */
export function hubsForEach() {
    const closers: (() => Promise<void>)[] = [];

    afterEach(async () => {
        for (const close of closers.splice(0)) {
            await close();
        }
    });

    const setUp = async (count = 1) => {
        const made = await hubOn(count);

        closers.push(made.close);

        return made;
    };

    return { setUp, closers };
}
