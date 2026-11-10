import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createRig, DISTROS, From, Market, type Provider, Refusal, type Rule, Slot } from "../src/index.js";
import { checkMatch } from "../src/rules.js";

describe("rules", () => {
    it("refuses a match whose keys are all undefined: it would match every rule", () => {
        expect(() => {
            checkMatch({ port: undefined });
        }).toThrow(Refusal);
    });

    it("opens all or none: a failed open closes what the call opened, then throws", async () => {
        const rules: Rule[] = [];
        const provider: Provider = {
            slot: Slot.PROVIDER,
            name: "a",
            rig: 1,
            can: { port: true },
            distros: Object.fromEntries(
                Object.entries(DISTROS).map(([distro, { versions }]) => {
                    return [distro, versions];
                }),
            ),
            async places() {
                return [{ market: Market.DEMAND, type: "t", zone: "z" }];
            },
            async create() {
                return { ok: { id: "m1" } };
            },
            async get() {
                return null;
            },
            async list() {
                return [];
            },
            async end() {},
            async reboot() {},
            port: {
                async open(_id, rule) {
                    if (rule.from === From.ANY6) {
                        throw new Error("no IPv6 here");
                    }

                    rules.push({ ...rule, id: "r1" });

                    return rules.at(-1)!;
                },
                async close(_id, id) {
                    rules.splice(
                        rules.findIndex((one) => {
                            return one.id === id;
                        }),
                        1,
                    );
                },
                async list() {
                    return [...rules];
                },
            },
        };

        const rig = createRig({
            rig: 1,
            app: "app",
            providers: [provider],
            kinds: [{ name: "d", try: [{ provider: "a", market: [Market.DEMAND], types: ["t"] }] }],
            store: mkdtempSync(join(tmpdir(), "rig-rules-")),
            extra: { rounds: false },
        });

        await rig.open();
        await rig.machine.create("d");

        await expect(rig.port.open("m1", { port: 443, from: From.ANY })).rejects.toThrow("no IPv6 here");
        expect(rules).toEqual([]);
    });
});
