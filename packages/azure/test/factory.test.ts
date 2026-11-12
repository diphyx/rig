import { describe, expect, it } from "vitest";

import { resolveAuth } from "../src/auth.js";
import { subscriptionOf } from "../src/config.js";
import { AuthFrom, createAzure } from "../src/index.js";
import { cleanEach, azure } from "./fake.js";

cleanEach();

describe("azure: factory", () => {
    it("takes the standard config, azure's own under extra, and refuses any other key", () => {
        expect(azure({}).provider).toMatchObject({ name: "azure", rig: 1, keys: ["tenant", "id", "secret"] });

        expect(() => {
            return createAzure({ region: "eastus", group: "g" } as never);
        }).toThrow(/unknown key group; azure's own go in extra/);

        expect(() => {
            return createAzure({ region: "eastus" });
        }).toThrow(/subscription is required/);
    });

    it("takes the subscription given, else RIG_<NAME>_SUBSCRIPTION's, else AZURE_SUBSCRIPTION_ID's", () => {
        process.env.AZURE_SUBSCRIPTION_ID = "cloud";
        expect(subscriptionOf({}, "azure")).toBe("cloud");

        process.env.RIG_AZURE_SUBSCRIPTION = "own";
        expect(subscriptionOf({}, "azure")).toBe("own");
        expect(subscriptionOf({ extra: { subscription: "given" } }, "azure")).toBe("given");

        process.env.RIG_AZURE_EU_SUBSCRIPTION = "eu";
        expect(subscriptionOf({}, "azure-eu")).toBe("eu");

        process.env.RIG_AZURE_SUBSCRIPTION = "";
        expect(subscriptionOf({}, "azure")).toBe("cloud");
    });

    it("reads RIG_AZURE_<KEY> for a service principal", () => {
        expect(
            resolveAuth(
                "azure",
                { from: AuthFrom.ENV },
                { RIG_AZURE_TENANT: "t", RIG_AZURE_ID: "i", RIG_AZURE_SECRET: "s" },
            ),
        ).toEqual({
            tenant: "t",
            id: "i",
            secret: "s",
        });
    });

    it("refuses a way to sign in that is not auto, env or keys, a key azure does not take, and a missing key", () => {
        expect(() => {
            return resolveAuth("azure", { from: "file" } as never);
        }).toThrow(/auth from file is not a way: auto, env or keys/);

        expect(() => {
            return resolveAuth("azure", {
                from: AuthFrom.KEYS,
                keys: { tenant: "t", id: "i", secret: "s", region: "r" } as never,
            });
        }).toThrow(/has a key azure does not take: region/);

        expect(() => {
            return resolveAuth("azure", { from: AuthFrom.KEYS, keys: { tenant: "t", id: "", secret: "s" } });
        }).toThrow(/auth from keys is missing id/);

        expect(() => {
            return resolveAuth("azure", { from: AuthFrom.ENV, prefix: "MINE" }, { MINE_TENANT: "t", MINE_ID: "i" });
        }).toThrow(/auth from env is missing secret/);
    });

    it("takes a config with no extra, its subscription from the env", () => {
        process.env.AZURE_SUBSCRIPTION_ID = "cloud";

        expect(createAzure({ region: "eastus" })).toMatchObject({ name: "azure" });
    });
});
