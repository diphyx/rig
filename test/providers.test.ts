import { Arch, PresetArch, PresetName, type PresetTable, Reason, Refusal, Slot } from "@diphyx/rig";
import { isArray } from "radash";
import { describe, expect, it } from "vitest";

import aws from "../packages/aws/src/aws.json" with { type: "json" };
import { createAws } from "../packages/aws/src/index.js";
import azure from "../packages/azure/src/azure.json" with { type: "json" };
import { createAzure } from "../packages/azure/src/index.js";
import gcp from "../packages/gcp/src/gcp.json" with { type: "json" };
import { createGcp } from "../packages/gcp/src/index.js";

/* Every official provider, made with a transport that answers nothing: these checks never reach a cloud. */
const nothing = async (): Promise<never> => {
    throw new Error("no cloud in this test");
};

const PROVIDERS = [
    {
        name: "aws",
        region: "us-east-1",
        table: aws.presets as PresetTable,
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
        table: gcp.presets as PresetTable,
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
        table: azure.presets as PresetTable,
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

describe.each(PROVIDERS)("provider $name", ({ name, table, keys, make }) => {
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
