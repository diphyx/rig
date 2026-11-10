import { connect as connectSocket } from "node:net";
import { isObject, tryit } from "radash";

import { decodeCbor, encodeCbor } from "./cbor.js";
import { Initiator, Responder } from "./noise.js";

import type { Socket } from "node:net";
import type { CborValue } from "./cbor.js";
import type { Keypair, Transport } from "./noise.js";

const PROLOGUE = "grid/2";
export const DEFAULT_PORT = 9420;
const MAX_PLAIN = 65535 - 16;
export const MAX_CHUNK = 60 * 1024;

const HANDSHAKE_TIMEOUT_MS = 10_000;
const SEND_QUEUE_LIMIT = 4 * 1024 * 1024;
const PING_AFTER_MS = 15_000;
const DEAD_AFTER_MS = 30_000;

export type RejectReason = "full" | "running" | "unknown" | "invalid";

export class GridReject extends Error {
    constructor(
        readonly reason: RejectReason,
        message?: string,
    ) {
        super(message ? `${reason}: ${message}` : reason);
    }
}

export class GridClosed extends Error {
    constructor(message = "connection closed") {
        super(message);
    }
}

export type CborMap = { [key: string]: CborValue };

/** How the hub answers a call on a connection the node dialed: `beat`, `post`. */
export type Answer = (call: string, body: CborMap) => CborMap | Promise<CborMap>;

export interface Envelope {
    id?: number;
    call?: string;
    body?: CborMap;
    ok?: CborMap;
    reject?: { reason: RejectReason; message?: string };
    data?: CborValue;
    end?: CborMap;
    cancel?: CborMap;
    ping?: CborMap;
    pong?: CborMap;
}

const KINDS = ["call", "ok", "reject", "data", "end", "cancel", "ping", "pong"] as const;

function kindOf(envelope: Envelope): string | null {
    const present = KINDS.filter((kind) => {
        return envelope[kind] !== undefined;
    });

    return present.length === 1 ? present[0]! : null;
}

/* Frames are `| u16 big-endian length | payload |` (spec §3), the handshake included. */
class FrameReader {
    private pending = Buffer.alloc(0);

    push(chunk: Buffer): Buffer[] {
        this.pending = Buffer.concat([this.pending, chunk]);
        const frames: Buffer[] = [];

        while (this.pending.length >= 2) {
            const length = this.pending.readUInt16BE(0);

            if (this.pending.length < 2 + length) {
                break;
            }

            frames.push(Buffer.from(this.pending.subarray(2, 2 + length)));
            this.pending = this.pending.subarray(2 + length);
        }

        return frames;
    }
}

function frame(payload: Buffer): Buffer {
    const head = Buffer.alloc(2);
    head.writeUInt16BE(payload.length);

    return Buffer.concat([head, payload]);
}

/* Envelopes for one call id, in arrival order, until the call is closed. */
export class Inbox {
    private readonly queue: Envelope[] = [];
    private waiter: ((envelope: Envelope | null) => void) | null = null;
    private closed: Error | null = null;

    put(envelope: Envelope) {
        if (this.waiter) {
            const resolve = this.waiter;
            this.waiter = null;
            resolve(envelope);

            return;
        }

        this.queue.push(envelope);
    }

    close(reason: Error) {
        this.closed ??= reason;

        if (this.waiter) {
            const resolve = this.waiter;
            this.waiter = null;
            resolve(null);
        }
    }

    async next(): Promise<Envelope> {
        const queued = this.queue.shift();

        if (queued) {
            return queued;
        }

        if (this.closed) {
            throw this.closed;
        }

        const envelope = await new Promise<Envelope | null>((resolve) => {
            this.waiter = resolve;
        });

        if (!envelope) {
            throw this.closed ?? new GridClosed();
        }

        return envelope;
    }
}

export class GridCall {
    constructor(
        readonly id: number,
        readonly inbox: Inbox,
        private readonly connection: GridConnection,
    ) {}

    next(): Promise<Envelope> {
        return this.inbox.next();
    }

    /* Waits for ok or reject; stream items that come first are not this call's answer. */
    async reply(): Promise<CborMap> {
        while (true) {
            const envelope = await this.next();

            if (envelope.reject) {
                throw new GridReject(envelope.reject.reason, envelope.reject.message);
            }

            if (envelope.ok) {
                return envelope.ok;
            }
        }
    }

    data(value: CborValue): Promise<void> {
        return this.connection.send({ id: this.id, data: value });
    }

    end(value: CborMap = {}): Promise<void> {
        return this.connection.send({ id: this.id, end: value });
    }

    cancel(): Promise<void> {
        return this.connection.send({ id: this.id, cancel: {} });
    }

    close() {
        this.connection.forget(this.id);
    }
}

/* One encrypted connection the hub dialed (spec §1, §4): it routes envelopes by id and keeps itself alive with ping. */
export class GridConnection {
    private readonly calls = new Map<number, Inbox>();
    private nextId = 0;
    private lastSend = Date.now();
    private lastReceive = Date.now();
    private readonly keepalive: NodeJS.Timeout;
    private problem: Error | null = null;
    private readonly closers: ((problem: Error) => void)[] = [];

    constructor(
        private readonly socket: Socket,
        private readonly transport: Transport,
        private readonly reader: FrameReader,
        leftover: Buffer[],
        /* A connection the node dialed (signal): its calls, `beat` and `post`, and their answers. */
        private readonly answer?: Answer,
    ) {
        socket.on("data", (chunk: Buffer) => {
            return this.receive(this.reader.push(chunk));
        });

        socket.on("close", () => {
            return this.finish(new GridClosed());
        });

        socket.on("error", (problem) => {
            return this.finish(problem);
        });

        this.keepalive = setInterval(() => {
            return this.tick();
        }, 1000);

        this.keepalive.unref();
        this.receive(leftover);
    }

    get peer(): Buffer {
        return this.transport.peer;
    }

    get isOpen(): boolean {
        return !this.problem;
    }

    onClose(listener: (problem: Error) => void) {
        if (this.problem) {
            listener(this.problem);

            return;
        }

        this.closers.push(listener);
    }

    private tick() {
        const now = Date.now();

        if (now - this.lastReceive > DEAD_AFTER_MS) {
            this.close(new GridClosed("connection silent for 30 s"));

            return;
        }

        if (now - this.lastSend > PING_AFTER_MS) {
            void this.send({ ping: {} }).catch(() => {
                return null;
            });
        }
    }

    private receive(frames: Buffer[]) {
        for (const payload of frames) {
            const envelope = this.open(payload);

            if (!envelope) {
                return;
            }

            this.lastReceive = Date.now();
            this.route(envelope);
        }
    }

    private open(payload: Buffer): Envelope | null {
        if (this.problem) {
            return null;
        }

        const [problem, decoded] = tryit(() => {
            return decodeCbor(this.transport.receiver.decrypt(payload));
        })();

        /* A frame that does not open breaks the cipher's order: nothing after it can be read. */
        if (problem || !isObject(decoded)) {
            this.close(problem ?? new Error("grid: envelope is not a map"));

            return null;
        }

        return decoded as Envelope;
    }

    private route(envelope: Envelope) {
        const kind = kindOf(envelope);

        if (kind === "ping") {
            void this.send({ pong: {} }).catch(() => {
                return null;
            });

            return;
        }

        /* Only the dialer calls (spec §1): on a connection the node dialed, it calls; on one the hub dialed, it may not. */
        if (kind === "call" && envelope.id) {
            void this.answerCall(envelope.id, envelope.call ?? "", envelope.body ?? {});

            return;
        }

        if (kind && envelope.id) {
            this.calls.get(envelope.id)?.put(envelope);
        }
    }

    private async answerCall(id: number, call: string, body: CborMap) {
        const [problem, ok] = this.answer
            ? await tryit(async () => {
                  return this.answer!(call, body);
              })()
            : [new Error("the hub takes no calls"), undefined];

        const reply: Envelope = problem
            ? { id, reject: { reason: "invalid", message: problem.message } }
            : { id, ok: ok ?? {} };

        await this.send(reply).catch(() => {
            return null;
        });
    }

    send(envelope: Envelope): Promise<void> {
        if (this.problem) {
            return Promise.reject(this.problem);
        }

        const plain = encodeCbor(envelope as CborMap);

        if (plain.length > MAX_PLAIN) {
            return Promise.reject(new Error("grid: envelope too large for one frame"));
        }

        /* Encrypt and write in one step, so the nonces follow the order on the wire. */
        this.socket.write(frame(this.transport.sender.encrypt(plain)));
        this.lastSend = Date.now();

        /* The socket's own mark (16 KiB) is below one chunk: wait only once a few MiB are queued, or every chunk waits. */
        return this.socket.writableLength > SEND_QUEUE_LIMIT ? this.drain() : Promise.resolve();
    }

    private drain(): Promise<void> {
        return new Promise((resolve, reject) => {
            const onDrain = () => {
                this.socket.off("close", onClose);
                resolve();
            };

            const onClose = () => {
                this.socket.off("drain", onDrain);
                reject(this.problem ?? new GridClosed());
            };

            this.socket.once("drain", onDrain);
            this.socket.once("close", onClose);
        });
    }

    async start(call: string, body: CborMap): Promise<GridCall> {
        this.nextId += 1;
        const id = this.nextId;
        const inbox = new Inbox();
        this.calls.set(id, inbox);

        const started = new GridCall(id, inbox, this);
        await this.send({ id, call, body }).catch((problem) => {
            started.close();

            throw problem;
        });

        return started;
    }

    async request(call: string, body: CborMap): Promise<CborMap> {
        const started = await this.start(call, body);

        return started.reply().finally(() => {
            return started.close();
        });
    }

    forget(id: number) {
        this.calls.get(id)?.close(new GridClosed("call closed"));
        this.calls.delete(id);
    }

    close(problem: Error = new GridClosed()) {
        this.finish(problem);
        this.socket.destroy();
    }

    private finish(problem: Error) {
        if (this.problem) {
            return;
        }

        this.problem = problem;
        clearInterval(this.keepalive);

        for (const inbox of this.calls.values()) {
            inbox.close(problem);
        }

        this.calls.clear();

        for (const listener of this.closers) {
            listener(problem);
        }
    }
}

function readHandshakeFrame(socket: Socket, reader: FrameReader): Promise<[Buffer, Buffer[]]> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            return fail(new Error("grid: handshake timed out"));
        }, HANDSHAKE_TIMEOUT_MS);

        function cleanup() {
            clearTimeout(timer);
            socket.off("data", onData);
            socket.off("close", onClose);
            socket.off("error", fail);
        }

        function fail(problem: Error) {
            cleanup();
            reject(problem);
        }

        function onClose() {
            fail(new GridClosed("closed during the handshake"));
        }

        function onData(chunk: Buffer) {
            const [first, ...rest] = reader.push(chunk);

            if (first) {
                cleanup();
                socket.pause();
                resolve([first, rest]);
            }
        }

        socket.on("data", onData);
        socket.once("close", onClose);
        socket.once("error", fail);
    });
}

function openSocket(ip: string, port: number): Promise<Socket> {
    return new Promise((resolve, reject) => {
        const socket = connectSocket({ host: ip, port, timeout: HANDSHAKE_TIMEOUT_MS });

        socket.once("connect", () => {
            socket.setTimeout(0);
            socket.off("error", reject);
            resolve(socket);
        });

        socket.once("timeout", () => {
            socket.destroy();
            reject(new Error(`grid: ${ip}:${port} did not answer`));
        });

        socket.once("error", reject);
    });
}

/* TCP, then the IK handshake as the initiator (spec §1): the hub is always the dialer. */
export async function dialGrid(options: {
    ip: string;
    port: number;
    local: Keypair;
    remote: Buffer;
}): Promise<GridConnection> {
    const socket = await openSocket(options.ip, options.port);
    const reader = new FrameReader();
    const initiator = new Initiator(options.local, options.remote, PROLOGUE);

    socket.write(frame(initiator.writeFirst()));

    const [problem, connection] = await tryit(async () => {
        const [reply, leftover] = await readHandshakeFrame(socket, reader);

        return new GridConnection(socket, initiator.readSecond(reply), reader, leftover);
    })();

    if (problem) {
        socket.destroy();

        throw problem;
    }

    socket.resume();

    return connection;
}

/** A connection a node dialed (signal): the IK handshake as the responder, from a node it knows, with its key. */
export async function acceptGrid(options: {
    socket: Socket;
    local: Keypair;
    /* Whether the hub trusts this key, from this socket's node. */
    trusts: (peer: Buffer) => boolean;
    answer: (peer: Buffer) => Answer;
}): Promise<GridConnection> {
    const { socket } = options;
    const reader = new FrameReader();
    const responder = new Responder(options.local, PROLOGUE);

    const [problem, connection] = await tryit(async () => {
        const [first, leftover] = await readHandshakeFrame(socket, reader);
        const peer = responder.readFirst(first);

        if (!options.trusts(peer)) {
            throw new Error("grid: a node dialed in with a key the hub does not trust");
        }

        const [second, transport] = responder.writeSecond();

        socket.write(frame(second));

        return new GridConnection(socket, transport, reader, leftover, options.answer(peer));
    })();

    if (problem) {
        socket.destroy();

        throw problem;
    }

    socket.resume();

    return connection;
}
