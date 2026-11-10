import { describe, expect, it } from "vitest";

import { checkFactory, createTagMap, Reason, type Refusal } from "../src/index.js";

describe("factory", () => {
    it("takes the standard keys and the provider's own extra keys", () => {
        expect(() => {
            checkFactory("mine", { region: "r", name: "n", auth: {}, identity: "i", extra: { zone: "z" } }, ["zone"]);
        }).not.toThrow();
    });

    it("refuses a key outside them, or no region, naming the key", () => {
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

        expect(refusal({})).toMatchObject({ message: expect.stringContaining("region is required") });
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
