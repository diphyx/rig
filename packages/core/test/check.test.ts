import { describe, expect, it } from "vitest";

import { createRig, Market, Reason, Refusal, type RigConfig, Slot } from "../src/index.js";

import { fakeProvider, fakeWorker, storeOf } from "./fake.js";

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA me@host";

/* A config of one provider and one kind, with `own` over its keys and `kind` over its kind's. */
function configOf(own: Record<string, unknown> = {}, kind: Record<string, unknown> = {}): RigConfig {
    return {
        rig: 1,
        app: "app",
        providers: [fakeProvider({ can: { port: true } }).provider],
        kinds: [{ name: "d", try: [{ provider: "a", market: [Market.DEMAND], types: ["t"] }], ...kind }],
        store: storeOf(),
        extra: { rounds: false },
        ...own,
    } as RigConfig;
}

/* The refusal the core's open gives for this config. */
async function refusalOf(config: RigConfig): Promise<Refusal> {
    const rig = createRig(config);
    const failure = await rig.open().then(
        () => {
            return undefined;
        },
        (error: unknown) => {
            return error;
        },
    );

    expect(failure).toBeInstanceOf(Refusal);

    return failure as Refusal;
}

describe("check: plugins", () => {
    it("refuses providers that are not a list", async () => {
        expect(await refusalOf(configOf({ providers: "a" }))).toMatchObject({
            reason: Reason.CONFIG,
            message: "providers: at least one",
        });
    });

    it("refuses a provider in the worker slot, or in a slot it does not know", async () => {
        const worker = fakeProvider({ slot: Slot.WORKER as never }).provider;
        const other = fakeProvider({ slot: "other" as never }).provider;

        expect(await refusalOf(configOf({ providers: [worker] }))).toMatchObject({
            reason: Reason.CONFIG,
            message: "providers[a].slot: a worker goes in workers, §22",
        });

        expect(await refusalOf(configOf({ providers: [other] }))).toMatchObject({
            reason: Reason.PLUGIN,
            message: "plugin a: unknown slot other",
        });
    });

    it("refuses a provider without a name, or with a check that is not a call", async () => {
        const nameless = fakeProvider({ name: undefined as never }).provider;
        const checkless = fakeProvider({ check: "yes" as never }).provider;

        expect((await refusalOf(configOf({ providers: [nameless] }))).message).toBe(
            "plugin undefined: name is not a name, or taken",
        );

        expect((await refusalOf(configOf({ providers: [checkless] }))).message).toBe("plugin a: check is not a call");
    });

    it("refuses a provider missing a call its can asks for, or one of its group", async () => {
        const startless = fakeProvider({ can: { stop: true }, start: undefined }).provider;
        const diskless = fakeProvider({ can: { disk: true }, disk: undefined }).provider;

        expect((await refusalOf(configOf({ providers: [startless] }))).message).toBe("plugin a: missing call start");

        expect((await refusalOf(configOf({ providers: [diskless] }))).message).toBe("plugin a: missing call disk.grow");
    });

    it("refuses a provider whose distros are not a table", async () => {
        const provider = fakeProvider({ distros: undefined as never }).provider;

        expect((await refusalOf(configOf({ providers: [provider] }))).message).toBe(
            "plugin a: distros does not offer ubuntu 24.04",
        );
    });
});

describe("check: workers", () => {
    it("refuses workers that are not a list, or a worker without a name", async () => {
        expect(await refusalOf(configOf({ workers: "w" }))).toMatchObject({
            reason: Reason.CONFIG,
            message: "workers: a list of workers",
        });

        expect(await refusalOf(configOf({ workers: [fakeWorker({ name: undefined as never })] }))).toMatchObject({
            reason: Reason.PLUGIN,
            message: "worker undefined: name is not a name, or taken",
        });
    });

    it("refuses a worker whose open is not a call, and opens one whose open is", async () => {
        const opened: string[] = [];

        expect((await refusalOf(configOf({ workers: [fakeWorker({ open: "yes" as never })] }))).message).toBe(
            "worker w: open is not a call",
        );

        const rig = createRig(
            configOf({
                workers: [
                    fakeWorker({
                        async open() {
                            opened.push("w");
                        },
                    }),
                ],
            }),
        );

        await rig.open();
        expect(opened).toEqual(["w"]);
        await rig.close();
    });

    it("refuses a kind's worker that is not an object, has a name that is not one, or needs a port that is not a rule", async () => {
        expect((await refusalOf(configOf({ workers: [fakeWorker()] }, { worker: "w" }))).message).toBe(
            "kinds[d].worker: not an object",
        );

        expect(
            (await refusalOf(configOf({ workers: [fakeWorker()] }, { worker: { name: "W", tags: ["x"] } }))).message,
        ).toBe("kinds[d].worker.name: not a name");

        const porter = fakeWorker({
            setup() {
                return { script: [], ports: [{ port: 0, from: "any" }], key: "k" };
            },
        });

        expect((await refusalOf(configOf({ workers: [porter] }, { worker: { tags: ["x"] } }))).message).toBe(
            "kinds[d].worker: its port 0: rule: port 0 is not from 1 to 65535",
        );
    });
});

describe("check: config", () => {
    it("refuses each root key that is not of its type", async () => {
        const cases: [Record<string, unknown>, string][] = [
            [{ app: 5 }, "app: not a name"],
            [{ providers: [] }, "providers: at least one"],
            [{ kinds: [] }, "kinds: at least one"],
            [{ guard: "maybe" }, "guard: warn or refuse"],
            [{ every: "soon" }, "every: not a dur"],
            [{ poll: "soon" }, "poll: not a dur"],
            [{ poll: "0" }, "poll: not a dur"],
            [{ store: null }, "store: not a str"],
            [{ store: 5 }, "store: not a str"],
            [{ extra: 5 }, "extra: not an object"],
        ];

        for (const [own, message] of cases) {
            expect(await refusalOf(configOf(own))).toMatchObject({ reason: Reason.CONFIG, message });
        }
    });

    it("refuses a kind without a name, or with a name taken", async () => {
        const kind = { name: "d", try: [{ provider: "a", market: [Market.DEMAND], types: ["t"] }] };

        expect((await refusalOf(configOf({ kinds: ["d"] }))).message).toBe("kinds: a kind without a name");
        expect((await refusalOf(configOf({ kinds: [kind, kind] }))).message).toBe("kinds[d].name: taken");
    });

    it("refuses each kind key that is not of its type", async () => {
        const cases: [Record<string, unknown>, string][] = [
            [{ distro: "ubuntu" }, "kinds[d].distro: not an object"],
            [{ distro: { name: "arch" } }, "kinds[d].distro.name: arch is not one of ubuntu, debian"],
            [
                { distro: { name: "ubuntu", version: "20.04" } },
                "kinds[d].distro.version: 20.04 is not one of 24.04, 22.04",
            ],
            [{ disk: 10 }, "kinds[d].disk: a uint from 30"],
            [{ login: "me" }, "kinds[d].login: not an object"],
            [{ login: { keys: [KEY], shell: "zsh" } }, "kinds[d].login.shell: unknown key"],
            [{ risk: "low" }, "kinds[d].risk: not an object"],
            [{ risk: { max: "low" } }, "kinds[d].risk.max: not a pct"],
            [{ life: "long" }, "kinds[d].life: not a dur"],
            [{ recovers: -1 }, "kinds[d].recovers: not a uint"],
            [{ tags: "team" }, "kinds[d].tags: not an object"],
            [{ ports: "22" }, "kinds[d].ports: a list of rules"],
            [{ ports: ["22"] }, "kinds[d].ports[0]: rule: a rule needs port and from"],
            [{ ports: [{ port: 22, from: 5 }] }, "kinds[d].ports[0]: rule: from 5 is not an IP, a CIDR, or any"],
            [{ try: [] }, "kinds[d].try: at least one entry"],
            [{ try: ["a"] }, "kinds[d].try[0]: not an object"],
        ];

        for (const [kind, message] of cases) {
            expect(await refusalOf(configOf({}, kind))).toMatchObject({ reason: Reason.CONFIG, message });
        }
    });

    it("refuses an entry's image or extra that is not of its type, and takes an extra that is", async () => {
        const entry = { provider: "a", market: [Market.DEMAND], types: ["t"] };

        expect((await refusalOf(configOf({}, { try: [{ ...entry, image: 5 }] }))).message).toBe(
            "kinds[d].try[0].image: not a str",
        );

        expect((await refusalOf(configOf({}, { try: [{ ...entry, extra: "x" }] }))).message).toBe(
            "kinds[d].try[0].extra: not an object",
        );

        const rig = createRig(configOf({}, { try: [{ ...entry, extra: { zone: "z" } }] }));

        await rig.open();
        await rig.close();
    });
});
