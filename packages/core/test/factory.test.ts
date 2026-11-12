import { describe, expect, it } from "vitest";

import { checkFactory, createTagMap, Reason, type Refusal, regionOf } from "../src/index.js";

describe("factory", () => {
    it("takes the standard keys and the provider's own extra keys", () => {
        expect(() => {
            checkFactory("mine", { region: "r", name: "n", auth: {}, identity: "i", extra: { zone: "z" } }, ["zone"]);
        }).not.toThrow();
    });

    it("refuses a key outside them, or an empty region, naming the key", () => {
        const refusal = (config: object): Refusal => {
            try {
                checkFactory("mine", config, ["zone"]);
            } catch (error) {
                return error as Refusal;
            }

            throw new Error("no refusal");
        };

        expect(refusal({ region: "r", zone: "z" })).toMatchObject({
            reason: Reason.CONFIG,
            message: expect.stringContaining("zone; mine's own go in extra"),
        });

        expect(refusal({ region: "r", extra: { zones: [] } })).toMatchObject({
            message: expect.stringContaining("extra.zones"),
        });

        expect(refusal({ region: "" })).toMatchObject({ message: expect.stringContaining("region is not a region") });

        expect(() => {
            checkFactory("mine", {}, []);
        }).not.toThrow();
    });

    it("takes the region given, else the cloud's env var's, else its default", () => {
        const before = process.env.RIG_TEST_REGION;

        delete process.env.RIG_TEST_REGION;
        expect(regionOf(undefined, ["RIG_TEST_REGION"], "home-1")).toBe("home-1");

        process.env.RIG_TEST_REGION = "env-1";
        expect(regionOf(undefined, ["RIG_TEST_REGION"], "home-1")).toBe("env-1");
        expect(regionOf("given-1", ["RIG_TEST_REGION"], "home-1")).toBe("given-1");

        if (before === undefined) {
            delete process.env.RIG_TEST_REGION;
        } else {
            process.env.RIG_TEST_REGION = before;
        }
    });

    it("takes RIG_<NAME>_REGION before the cloud's env var's, by the provider's name", () => {
        const before = process.env.RIG_AWS_EAST_REGION;

        process.env.RIG_AWS_EAST_REGION = "own-1";
        expect(regionOf(undefined, [], "home-1", "aws-east")).toBe("own-1");
        expect(regionOf("given-1", [], "home-1", "aws-east")).toBe("given-1");
        expect(regionOf(undefined, [], "home-1", "aws-west")).toBe("home-1");

        process.env.RIG_AWS_EAST_REGION = "";
        expect(regionOf(undefined, [], "home-1", "aws-east")).toBe("home-1");

        if (before === undefined) {
            delete process.env.RIG_AWS_EAST_REGION;
        } else {
            process.env.RIG_AWS_EAST_REGION = before;
        }
    });
});

describe("tag map", () => {
    it("renames rig's tags onto the provider's names, and back", () => {
        const tags = createTagMap({ "rig-app": "rig_app" });
        const own = tags.to({ rig: "1", "rig-app": "app", team: "x" });

        expect(own).toEqual({ rig: "1", rig_app: "app", team: "x" });
        expect(tags.from(own)).toEqual({ rig: "1", "rig-app": "app", team: "x" });
    });
});
