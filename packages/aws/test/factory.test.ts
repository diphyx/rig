import { Refusal } from "@diphyx/rig";
import { describe, expect, it } from "vitest";

import { resolveAuth } from "../src/auth.js";
import { AuthFrom, createAws } from "../src/index.js";
import { fake, SUBNETS, GROUP, ARM, run, PLACE, SPEC } from "./fake.js";

describe("aws: factory", () => {
    it("takes the standard config, aws's own under extra, and refuses any other key", () => {
        expect(createAws({ region: "us-east-1", extra: { client: fake({}).client } })).toMatchObject({
            name: "aws",
            rig: 1,
        });

        expect(createAws({ region: "eu-west-1", name: "aws-eu", extra: { client: fake({}).client } }).name).toBe(
            "aws-eu",
        );

        expect(() => {
            return createAws({ region: "us-east-1", subnets: ["subnet-a"] } as never);
        }).toThrow(/unknown key subnets; aws's own go in extra/);

        expect(() => {
            return createAws({ region: "us-east-1", extra: { subnet: ["subnet-a"] } } as never);
        }).toThrow(/unknown key extra.subnet/);

        /* No region: the cloud's own env var's, else its default. */
        expect(createAws({ extra: { client: fake({}).client } })).toMatchObject({ name: "aws" });
    });

    it("is the SDK's own chain for auto, the default", () => {
        expect(resolveAuth("aws")).toBeNull();
        expect(resolveAuth("aws", { from: AuthFrom.AUTO })).toBeNull();
    });

    it("reads RIG_<NAME>_<KEY> from env, upper case, - as _", () => {
        expect(
            resolveAuth("aws-east", { from: AuthFrom.ENV }, { RIG_AWS_EAST_ID: "i", RIG_AWS_EAST_SECRET: "s" }),
        ).toEqual({
            id: "i",
            secret: "s",
        });

        expect(
            resolveAuth("aws", { from: AuthFrom.ENV, prefix: "MY" }, { MY_ID: "i", MY_SECRET: "s", MY_TOKEN: "t" }),
        ).toEqual({ id: "i", secret: "s", token: "t" });
    });

    it("takes keys passed in", () => {
        expect(resolveAuth("aws", { from: AuthFrom.KEYS, keys: { id: "i", secret: "s" } })).toEqual({
            id: "i",
            secret: "s",
        });
    });

    it("refuses at once a missing key or one aws does not take, never showing a value", () => {
        expect(() => {
            return createAws({ region: "us-east-1", auth: { from: AuthFrom.ENV, prefix: "NONE" } });
        }).toThrow(/missing id/);

        try {
            resolveAuth("aws", { from: AuthFrom.KEYS, keys: { id: "i", secret: "very-secret", pass: "p" } as never });
        } catch (error) {
            expect(error).toBeInstanceOf(Refusal);
            expect((error as Refusal).reason).toBe("plugin");
            expect((error as Refusal).message).toContain("pass");
            expect((error as Refusal).message).not.toContain("very-secret");
        }
    });

    it("names its keys, and runs machines as its identity", async () => {
        const inputs: Record<string, unknown>[] = [];
        const { client } = fake({ ...SUBNETS, ...GROUP, ...ARM, RunInstances: run(inputs) });
        const cloud = createAws({ region: "us-east-1", identity: "rig-machines", extra: { client } });

        expect(cloud.keys).toEqual(["id", "secret", "token?"]);

        await cloud.create(PLACE, SPEC);

        expect(inputs[0]).toMatchObject({ IamInstanceProfile: { Name: "rig-machines" } });
    });

    it("refuses a way that is not auto, env or keys", () => {
        expect(() => {
            return resolveAuth("aws", { from: "vault" } as never);
        }).toThrow(/from vault is not a way: auto, env or keys/);
    });

    it("leaves out an empty optional key, and refuses an empty one it needs", () => {
        expect(resolveAuth("aws", { from: AuthFrom.KEYS, keys: { id: "i", secret: "s", token: "" } })).toEqual({
            id: "i",
            secret: "s",
        });

        expect(() => {
            return resolveAuth("aws", { from: AuthFrom.KEYS, keys: { id: "i", secret: "" } });
        }).toThrow(/from keys is missing secret/);
    });
});
