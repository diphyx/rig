import { connect, createServer, type AddressInfo, type Server, type Socket } from "node:net";

import { sleep } from "radash";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CipherState, Initiator, Responder } from "../src/noise.js";
import { acceptGrid, dialGrid, GridClosed, GridReject, Inbox, MAX_CHUNK, type GridConnection } from "../src/wire.js";
import { FakeNode, frameOf } from "./fake-node.js";
import { randomPair, until } from "./helpers.js";

const servers: Server[] = [];
const accepted: Socket[] = [];
const nodes: FakeNode[] = [];
const connections: GridConnection[] = [];

afterEach(async () => {
    vi.useRealTimers();

    for (const connection of connections.splice(0)) {
        connection.close();
    }

    for (const node of nodes.splice(0)) {
        await node.stop();
    }

    for (const socket of accepted.splice(0)) {
        socket.destroy();
    }

    for (const server of servers.splice(0)) {
        await new Promise((resolve) => {
            server.close(resolve);
        });
    }
});

/* A TCP server on a free port, each socket given to the test. */
async function serve(onSocket: (socket: Socket) => void): Promise<number> {
    const server = createServer((socket) => {
        accepted.push(socket);
        onSocket(socket);
    });

    servers.push(server);

    await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
    });

    return (server.address() as AddressInfo).port;
}

async function nodeAndConnection(): Promise<{ node: FakeNode; connection: GridConnection }> {
    const node = await new FakeNode().start();

    nodes.push(node);

    const connection = await dialGrid({ ip: "127.0.0.1", port: node.port, local: randomPair(), remote: node.key });

    connections.push(connection);

    return { node, connection };
}

describe("noise", () => {
    it("refuses a sealed message shorter than its tag, and a handshake message too short", () => {
        const pair = randomPair();

        expect(() => {
            return new CipherState(Buffer.alloc(32)).decrypt(Buffer.alloc(15));
        }).toThrow("message too short");

        expect(() => {
            return new Initiator(pair, randomPair().public, "grid/2").readSecond(Buffer.alloc(47));
        }).toThrow("handshake reply too short");

        expect(() => {
            return new Responder(pair, "grid/2").readFirst(Buffer.alloc(95));
        }).toThrow("handshake message too short");
    });
});

describe("grid/2 inbox", () => {
    it("gives what came before the call closed, then the reason it closed", async () => {
        const inbox = new Inbox();

        inbox.put({ id: 1, data: 1 });
        inbox.close(new GridClosed("call closed"));
        inbox.close(new GridClosed("again"));

        expect(await inbox.next()).toEqual({ id: 1, data: 1 });
        await expect(inbox.next()).rejects.toThrow("call closed");
    });
});

describe("grid/2 dial", () => {
    it("fails when nothing listens, when the node closes or resets during the handshake, and on a reply too short", async () => {
        const closed = await serve((socket) => {
            socket.once("data", () => {
                socket.end();
            });
        });

        const reset = await serve((socket) => {
            socket.destroy();
        });

        const short = await serve((socket) => {
            socket.write(frameOf(Buffer.alloc(10)));
        });

        const refused = await serve(() => {});

        servers.pop()!.close();

        const dial = (port: number) => {
            return dialGrid({ ip: "127.0.0.1", port, local: randomPair(), remote: randomPair().public });
        };

        await expect(dial(refused)).rejects.toThrow("ECONNREFUSED");
        await expect(dial(closed)).rejects.toThrow("closed during the handshake");
        await expect(dial(reset)).rejects.toThrow();
        await expect(dial(short)).rejects.toThrow("handshake reply too short");
    });

    it("gives up on a handshake the node never answers", async () => {
        const silent = await serve(() => {});

        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

        const dialing = dialGrid({ ip: "127.0.0.1", port: silent, local: randomPair(), remote: randomPair().public });
        const settled = dialing.catch((problem: Error) => {
            return problem;
        });

        while (vi.getTimerCount() === 0) {
            await new Promise((resolve) => {
                setImmediate(resolve);
            });
        }

        vi.advanceTimersByTime(10_000);

        expect(await settled).toMatchObject({ message: "grid: handshake timed out" });
    });

    it("accepts a node's handshake only when it opens, and fails on a socket error mid-handshake", async () => {
        const local = randomPair();
        const problems: Promise<unknown>[] = [];
        const sockets: Socket[] = [];

        const port = await serve((socket) => {
            sockets.push(socket);

            problems.push(
                acceptGrid({
                    socket,
                    local,
                    trusts: () => {
                        return true;
                    },
                    answer: () => {
                        return () => {
                            return {};
                        };
                    },
                }).catch((problem: Error) => {
                    return problem.message;
                }),
            );
        });

        const garbage = createConnectionTo(port);

        garbage.write(frameOf(Buffer.alloc(20)));

        await until(() => {
            return problems.length === 1;
        });

        expect(await problems[0]).toMatch("handshake message too short");

        const broken = createConnectionTo(port);

        await until(() => {
            return sockets.length === 2;
        });

        sockets[1]!.destroy(new Error("the socket broke"));
        expect(await problems[1]).toBe("the socket broke");
        broken.destroy();
    });
});

/* A plain TCP connection to a port, its errors kept quiet. */
function createConnectionTo(port: number): Socket {
    const socket = connect(port, "127.0.0.1");

    socket.on("error", () => {
        return null;
    });

    return socket;
}

describe("grid/2 connection", () => {
    it("skips stream items before a call's answer, and gives a reject with or without its message", async () => {
        const { node, connection } = await nodeAndConnection();

        node.handlers.first = (call) => {
            call.data("ahead");
            call.ok({ answer: 1 });
        };

        node.handlers.second = (call) => {
            call.reject("full");
        };

        node.handlers.third = (call) => {
            call.reject("invalid", "a bad body");
        };

        expect(await connection.request("first", {})).toEqual({ answer: 1 });
        await expect(connection.request("second", {})).rejects.toThrow(new GridReject("full"));
        await expect(connection.request("third", {})).rejects.toThrow("invalid: a bad body");
        await expect(connection.request("fourth", {})).rejects.toThrow("unknown: no call fourth");
    });

    it("sends a call's data, end and cancel to the node", async () => {
        const { node, connection } = await nodeAndConnection();

        node.handlers.stream = () => {};

        const started = await connection.start("stream", {});

        await started.data(Buffer.from("abc"));
        await started.end();
        await started.cancel();

        await until(() => {
            return node.received.length === 4;
        });

        expect(node.received.slice(1)).toEqual([
            { id: started.id, data: Buffer.from("abc") },
            { id: started.id, end: {} },
            { id: started.id, cancel: {} },
        ]);

        started.close();
    });

    it("answers a node's ping, refuses its calls, and passes over envelopes with no call id or two kinds", async () => {
        const { node, connection } = await nodeAndConnection();
        const fake = node.connection;

        node.handlers.slow = () => {};

        const started = await connection.start("slow", {});

        fake.send({ ping: {} });
        fake.send({ id: 7, call: "beat" });
        fake.send({ ok: {} });
        fake.send({ id: started.id, ok: {}, data: 1 } as never);
        fake.send({ id: started.id, data: 2 });

        expect(await started.next()).toEqual({ id: started.id, data: 2 });
        started.close();

        await until(() => {
            return node.received.length >= 3;
        });

        expect(node.received.slice(1)).toEqual(
            expect.arrayContaining([
                { pong: {} },
                { id: 7, reject: { reason: "invalid", message: "the hub takes no calls" } },
            ]),
        );
    });

    it("closes on a frame that does not open, and on an envelope that is not a map", async () => {
        for (const payload of [Buffer.from("not sealed at all"), null]) {
            const { node, connection } = await nodeAndConnection();
            const closed: string[] = [];

            node.handlers.wait = () => {};

            const started = await connection.start("wait", {});

            connection.onClose((problem) => {
                closed.push(problem.message);
            });

            if (payload) {
                node.connection.raw(payload);
            } else {
                node.connection.sendValue([1]);
            }

            await expect(started.next()).rejects.toThrow(payload ? /./ : "envelope is not a map");

            connection.onClose((problem) => {
                closed.push(`late: ${problem.message}`);
            });

            expect(closed).toHaveLength(2);
            expect(connection.isOpen).toBe(false);
            await expect(connection.send({ ping: {} })).rejects.toThrow();
            await expect(connection.start("wait", {})).rejects.toThrow();
        }
    });

    it("reads a frame that comes in two pieces, and knows its peer's key", async () => {
        const { node, connection } = await nodeAndConnection();

        node.handlers.slow = () => {};

        const started = await connection.start("slow", {});
        const bytes = node.connection.frameFor({ id: started.id, data: "whole" });

        node.connection.socket.write(bytes.subarray(0, 1));
        await sleep(20);
        node.connection.socket.write(bytes.subarray(1, 5));
        await sleep(20);
        node.connection.socket.write(bytes.subarray(5));

        expect(await started.next()).toEqual({ id: started.id, data: "whole" });
        expect(connection.peer.equals(node.key)).toBe(true);
        started.close();
    });

    it("answers a call on a connection the node dialed, with an empty ok for no answer, even once it closed", async () => {
        const local = randomPair();
        const answered: string[] = [];
        const accepted: GridConnection[] = [];

        const port = await serve((socket) => {
            void acceptGrid({
                socket,
                local,
                trusts: () => {
                    return true;
                },
                answer: () => {
                    return async (call) => {
                        await sleep(call === "late" ? 50 : 0);
                        answered.push(call);

                        return undefined as never;
                    };
                },
            }).then((connection) => {
                accepted.push(connection);
            });
        });

        const node = await dialGrid({ ip: "127.0.0.1", port, local: randomPair(), remote: local.public });

        expect(await node.request("beat", {})).toEqual({});

        await node.start("late", {});
        node.close();

        await until(() => {
            return answered.includes("late");
        });

        expect(accepted[0]!.isOpen).toBe(false);
    });

    it("refuses an envelope too large for one frame", async () => {
        const { connection } = await nodeAndConnection();

        await expect(connection.send({ id: 1, data: Buffer.alloc(70_000) })).rejects.toThrow("too large for one frame");
    });

    it("waits for the socket to drain once a few MiB are queued, and fails the wait when it closes", async () => {
        const { node, connection } = await nodeAndConnection();
        const chunk = Buffer.alloc(MAX_CHUNK);

        /* Chunks, one after another, until one waits for the socket to drain: that one. */
        const fill = async (): Promise<{ sending: Promise<void> }> => {
            for (let count = 0; count < 1000; count += 1) {
                const sending = connection.send({ id: 1, data: chunk });

                const state = await Promise.race([
                    sending.then(() => {
                        return "sent";
                    }),
                    sleep(0).then(() => {
                        return "waiting";
                    }),
                ]);

                if (state === "waiting") {
                    return { sending };
                }
            }

            throw new Error("the socket never filled");
        };

        node.connection.socket.pause();
        const drained = await fill();

        node.connection.socket.resume();
        await expect(drained.sending).resolves.toBeUndefined();

        node.connection.socket.pause();
        const cut = await fill();

        node.cut();
        await expect(cut.sending).rejects.toThrow();
    });

    it("pings a quiet node after 15 s, and closes one silent for 30 s", async () => {
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });

        const { node, connection } = await nodeAndConnection();
        const closed: string[] = [];

        connection.onClose((problem) => {
            closed.push(problem.message);
        });

        vi.advanceTimersByTime(16_000);

        await until(() => {
            return node.received.some((envelope) => {
                return envelope.ping;
            });
        });

        node.isSilent = true;
        vi.advanceTimersByTime(31_000);

        expect(closed).toEqual(["connection silent for 30 s"]);
    });
});
