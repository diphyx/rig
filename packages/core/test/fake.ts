import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    DISTROS,
    Market,
    type Provider,
    type ProviderMachine,
    type Rule,
    Slot,
    Status,
    type Worker,
} from "../src/index.js";

/** Every distro version of §6.1, as a provider offers them. */
export const EVERY_DISTRO = Object.fromEntries(
    Object.entries(DISTROS).map(([distro, { versions }]) => {
        return [distro, versions];
    }),
);

/** A fresh store folder. */
export function storeOf(): string {
    return mkdtempSync(join(tmpdir(), "rig-test-"));
}

/** A provider of one demand and one spot place, whose machines run at once; `can` and the rest as given. */
export function fakeProvider(own: Partial<Provider> = {}) {
    const machines: ProviderMachine[] = [];
    const rules = new Map<string, Rule[]>();
    const calls: string[] = [];
    let rule = 0;

    const find = (id: string): ProviderMachine | undefined => {
        return machines.find((machine) => {
            return machine.id === id;
        });
    };

    const provider: Provider = {
        slot: Slot.PROVIDER,
        name: "a",
        rig: 1,
        distros: EVERY_DISTRO,
        async places() {
            return [
                { market: Market.DEMAND, type: "t", zone: "z" },
                { market: Market.SPOT, type: "t", zone: "z" },
            ];
        },
        async create(place, spec) {
            const id = `m${machines.length + 1}`;

            machines.push({
                id,
                status: Status.RUNNING,
                market: place.market,
                type: place.type,
                zone: place.zone,
                tags: spec.tags,
                ip: { private: "10.0.0.1" },
                created: 0,
            });

            return { ok: { id } };
        },
        async get(id) {
            return structuredClone(find(id) ?? null);
        },
        async list() {
            return structuredClone(machines);
        },
        async end(id) {
            calls.push(`end ${id}`);
            find(id)!.status = Status.ENDED;
        },
        async reboot(id) {
            calls.push(`reboot ${id}`);
        },
        async start(id) {
            calls.push(`start ${id}`);
            find(id)!.status = Status.RUNNING;
        },
        async stop(id) {
            calls.push(`stop ${id}`);
            find(id)!.status = Status.STOPPED;
        },
        disk: {
            async grow() {},
            async get() {
                return { gb: 30, ready: true };
            },
        },
        port: {
            async open(id, one) {
                rule += 1;

                const made = { ...one, id: `r${rule}` };

                rules.set(id, [...(rules.get(id) ?? []), made]);

                return made;
            },
            async close(id, gone) {
                rules.set(
                    id,
                    (rules.get(id) ?? []).filter((one) => {
                        return one.id !== gone;
                    }),
                );
            },
            async list(id) {
                return structuredClone(rules.get(id) ?? []);
            },
        },
        ...own,
    };

    return { provider, machines, calls };
}

/** A worker that takes every machine, with the ports and lines it is given. */
export function fakeWorker(own: Partial<Worker> = {}): Worker {
    return {
        slot: Slot.WORKER,
        name: "w",
        rig: 1,
        check() {},
        setup() {
            return { script: ["echo worker"], ports: [], key: "k" };
        },
        async add() {},
        async drop() {},
        async spent() {},
        ...own,
    };
}
