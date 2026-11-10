import { createServer, type Socket } from "node:net";

import { tryit } from "radash";

import type { GridHub } from "./hub.js";
import type { Log } from "./nodes.js";
import type { Keypair } from "./noise.js";
import { acceptGrid, type CborMap } from "./wire.js";

/* An IPv4 peer, as a dual-stack socket gives it: `::ffff:1.2.3.4` is `1.2.3.4`. */
function ipOf(address: string | undefined): string {
    return (address ?? "").replace(/^::ffff:/, "");
}

/** The hub's listener: `drop` closes a node's connections, `close` stops it and closes them all. */
export type Listener = { drop(name: string): void; close(): Promise<void> };

/** grid spec §1.5: the hub listens for nodes with signal; one it does not know, by IP and key, is closed at once. */
export function listenGrid(options: { port: number; local: Keypair; hub: GridHub; log: Log }): Promise<Listener> {
    const { hub, log } = options;

    /* Each connection, by the name of the node it is from, once the handshake says which. */
    const sockets = new Map<Socket, string | null>();

    const server = createServer((socket) => {
        const ip = ipOf(socket.remoteAddress);

        sockets.set(socket, null);

        socket.once("close", () => {
            sockets.delete(socket);
        });

        if (!hub.nodeAt(ip)) {
            socket.destroy();

            return;
        }

        /* The node is the one at this IP with this key: a reused IP never takes another's beats. */
        const linkOf = (peer: Buffer) => {
            return hub.links.find((link) => {
                return link.entry.ip === ip && link.entry.trust.equals(peer);
            });
        };

        void tryit(acceptGrid)({
            socket,
            local: options.local,
            trusts: (peer) => {
                const link = linkOf(peer);

                sockets.set(socket, link?.entry.name ?? null);

                return Boolean(link);
            },
            /* `beat`: the node is alive, and whether its share is on; a job's `post` is read by `tail` too. */
            answer: (peer) => {
                return (call: string, body: CborMap): CborMap => {
                    if (call !== "beat" && call !== "post") {
                        throw new Error(`the hub takes no ${call}`);
                    }

                    const link = linkOf(peer);

                    if (call === "beat" && link) {
                        link.beat();

                        if (body.share === true || body.share === false) {
                            link.shares(body.share);
                        }
                    }

                    return {};
                };
            },
        }).then(([problem]) => {
            if (problem) {
                log(`a node at ${ip} did not join: ${problem.message}`);
            }
        });
    });

    return new Promise((resolve, reject) => {
        server.once("error", reject);

        server.listen(options.port, () => {
            server.off("error", reject);

            /* A later error, like no file handles left, is told, not thrown. */
            server.on("error", (problem) => {
                log(`the hub's listener: ${problem.message}`);
            });

            resolve({
                drop: (name) => {
                    for (const [socket, of] of sockets) {
                        if (of === name) {
                            socket.destroy();
                        }
                    }
                },
                close: () => {
                    return new Promise<void>((done) => {
                        server.close(() => {
                            done();
                        });

                        /* A node keeps its connection open: closing the hub closes them all. */
                        for (const socket of sockets.keys()) {
                            socket.destroy();
                        }
                    });
                },
            });
        });
    });
}
