import {
    Arch,
    Busy,
    DISTROS,
    Distro,
    PresetArch,
    PresetName,
    type PresetTable,
    Reason,
    Refusal,
    Slot,
} from "@diphyx/rig";

import { isArray } from "radash";
import { describe, expect, it } from "vitest";

import aws from "../../packages/aws/src/aws.json" with { type: "json" };
import { createAws } from "../../packages/aws/src/index.js";
import azure from "../../packages/azure/src/azure.json" with { type: "json" };
import { createAzure } from "../../packages/azure/src/index.js";
import gcp from "../../packages/gcp/src/gcp.json" with { type: "json" };
import { createGcp } from "../../packages/gcp/src/index.js";

/* A provider's data file, as every one is laid out (spec §11): the keys this test reads. */
type Data = {
    rig: number;
    name: string;
    region: { env: string[]; default: string };
    busy: Record<string, string>;
    tags: Record<string, string>;
};

/* Every official provider, made with a transport that answers nothing: these checks never reach a cloud. */
const nothing = async (): Promise<never> => {
    throw new Error("no cloud in this test");
};

const PROVIDERS = [
    {
        name: "aws",
        region: "us-east-1",
        data: aws as Data,
        table: aws.presets as PresetTable,
        distros: aws.distros as Record<string, Record<string, Record<string, unknown>>>,
        keys: ["id", "secret", "token?"],
        make: (config: Record<string, unknown>) => {
            return createAws({
                region: "us-east-1",
                ...config,
                extra: { client: { send: nothing }, ...(config.extra as object) },
            } as never);
        },
    },
    {
        name: "gcp",
        region: "us-central1",
        data: gcp as Data,
        table: gcp.presets as PresetTable,
        distros: gcp.distros as Record<string, Record<string, Record<string, unknown>>>,
        keys: ["key"],
        make: (config: Record<string, unknown>) => {
            return createGcp({
                region: "us-central1",
                ...config,
                extra: { project: "p", request: nothing, ...(config.extra as object) },
            } as never);
        },
    },
    {
        name: "azure",
        region: "eastus",
        data: azure as Data,
        table: azure.presets as PresetTable,
        distros: azure.distros as Record<string, Record<string, Record<string, unknown>>>,
        keys: ["tenant", "id", "secret"],
        make: (config: Record<string, unknown>) => {
            return createAzure({
                region: "eastus",
                ...config,
                extra: { subscription: "s", request: nothing, ...(config.extra as object) },
            } as never);
        },
    },
];

/* Every type a preset table lists, with the arch it is listed under. */
function typesOf(table: PresetTable): { type: string; arch: string }[] {
    return Object.values(table).flatMap((arches) => {
        return Object.entries(arches).flatMap(([arch, sold]) => {
            return (isArray(sold) ? sold : Object.values(sold).flat()).map((type) => {
                return { type, arch };
            });
        });
    });
}

describe.each(PROVIDERS)("provider $name", ({ name, data, table, distros, keys, make }) => {
    it("is a rig 1 provider of the same shape: slot, name, keys, can, presets, shape, every call", () => {
        const provider = make({});

        expect(provider).toMatchObject({
            slot: Slot.PROVIDER,
            name,
            rig: 1,
            keys,
            can: { spot: true, stop: true, disk: true, port: true },
        });

        for (const call of ["check", "shape", "places", "create", "get", "list", "end", "reboot", "start", "stop"]) {
            expect(typeof (provider as unknown as Record<string, unknown>)[call], call).toBe("function");
        }

        for (const call of ["grow", "get"]) {
            expect(typeof provider.disk![call as "grow"]).toBe("function");
        }

        for (const call of ["open", "close", "list"]) {
            expect(typeof provider.port![call as "open"]).toBe("function");
        }
    });

    it("has a data file laid out as every one: rig 1, its name, its region, busy answers rig knows", () => {
        expect(data).toMatchObject({ rig: 1, name });

        expect(data.region.env.length).toBeGreaterThan(0);
        expect(data.region.default).not.toBe("");

        expect(Object.keys(data.busy).length).toBeGreaterThan(0);

        for (const [code, busy] of Object.entries(data.busy)) {
            expect(Object.values(Busy), code).toContain(busy);
        }

        /* Its tag names, both ways: no two of rig's names onto one of the cloud's. */
        expect(new Set(Object.values(data.tags)).size).toBe(Object.keys(data.tags).length);
    });

    it("takes its name, and refuses a key outside the standard config, or no region", () => {
        expect(make({ name: `${name}-eu` }).name).toBe(`${name}-eu`);

        for (const config of [{ subnets: [] }, { region: "" }]) {
            try {
                make(config);
                expect.unreachable();
            } catch (error) {
                expect(error).toBeInstanceOf(Refusal);
                expect((error as Refusal).reason).toBe(Reason.CONFIG);
            }
        }
    });

    it("signs in the same three ways: a missing env key is a refusal naming the key", () => {
        try {
            make({ auth: { from: "env", prefix: "RIG_TEST_NONE" } });
            expect.unreachable();
        } catch (error) {
            expect((error as Refusal).reason).toBe(Reason.PLUGIN);
            expect((error as Refusal).message).toContain(`missing ${keys[0]!}`);
        }
    });

    it("offers every distro at its default version, and each version it offers on both arches", () => {
        const provider = make({});

        for (const [name, { default: version, versions }] of Object.entries(DISTROS)) {
            expect(provider.distros[name as Distro]).toContain(version);

            for (const offered of provider.distros[name as Distro] ?? []) {
                expect(versions).toContain(offered);
                expect(Object.keys(distros[name]![offered]!).sort()).toEqual([Arch.ARM, Arch.X86]);
            }
        }

        expect(
            provider.presets.compute({ name: "k", distro: { name: Distro.DEBIAN }, arch: PresetArch.ANY }).distro,
        ).toEqual({
            name: Distro.DEBIAN,
        });

        expect(provider.presets.small({ name: "k", image: "mine", arch: PresetArch.X86 }).try[0]!.image).toBe("mine");

        expect(() => {
            return provider.presets.small({
                name: "k",
                image: "mine",
                arch: PresetArch.X86,
                distro: { name: Distro.DEBIAN },
            });
        }).toThrow(Refusal);
    });

    it("makes the same five presets from a name alone", () => {
        const provider = make({});

        for (const preset of Object.values(PresetName)) {
            const kind = provider.presets[preset]({ name: "k" });

            expect(kind.name).toBe("k");
            expect(kind.try).toHaveLength(1);
            expect(kind.try[0]!.provider).toBe(name);
            expect(kind.try[0]!.types.length).toBeGreaterThan(0);
        }

        expect(() => {
            return provider.presets.compute({ name: "k", image: "mine", arch: PresetArch.ANY });
        }).toThrow(Refusal);

        expect(provider.presets.small({ name: "k" }).disk).toBe(30);
        expect(provider.presets.general({ name: "k" }).disk).toBe(40);
        expect(provider.presets.compute({ name: "k", cpu: 16 }).disk).toBe(110);
        expect(provider.presets.memory({ name: "k", mem: 128 }).disk).toBe(100);
        expect(provider.presets.gpu({ name: "k" }).disk).toBe(200);
        expect(provider.presets.compute({ name: "k", disk: 500 }).disk).toBe(500);
        expect(provider.presets.compute({ name: "k", image: "mine", arch: PresetArch.X86 }).disk).toBeUndefined();

        expect(provider.presets.small({ name: "k", ports: [{ port: 22, from: "1.2.3.4/32" }] }).ports).toEqual([
            { port: 22, from: "1.2.3.4/32" },
        ]);
    });

    it("reads a shape for every type its presets list, on the arch it is listed under", async () => {
        const provider = make({});
        const wrong: string[] = [];

        for (const { type, arch } of typesOf(table)) {
            const shape = await provider.shape!(type);

            if (!shape || shape.arch !== (arch === "arm" ? Arch.ARM : Arch.X86) || shape.cpu <= 0 || shape.mem <= 0) {
                wrong.push(`${type} (${arch}): ${JSON.stringify(shape)}`);
            }
        }

        expect(wrong).toEqual([]);
    });
});
