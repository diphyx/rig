import { describe, expect, it } from "vitest";

import { Reason, Refusal } from "@diphyx/rig";

import { accountOf, resolveAuth } from "../src/auth.js";
import { AuthFrom, createGcp } from "../src/index.js";

import { gcp } from "./fake.js";

describe("gcp: factory", () => {
    /* A service-account key with its project, and one with its account only: its project found elsewhere. */
    const KEY = JSON.stringify({ client_email: "a@p.iam.gserviceaccount.com", private_key: "pk", project_id: "p" });
    const BARE_KEY = JSON.stringify({ client_email: "a@p.iam.gserviceaccount.com", private_key: "pk" });

    it("takes the standard config, gcp's own under extra, and refuses any other key", () => {
        expect(gcp({}).provider).toMatchObject({ name: "gcp", rig: 1, keys: ["key"] });

        expect(() => {
            return createGcp({ region: "us-central1", project: "p" } as never);
        }).toThrow(/unknown key project; gcp's own go in extra/);

        /* No region: the cloud's own env var's, else its default. */
        expect(createGcp({ extra: { project: "p" } })).toMatchObject({ name: "gcp" });
    });

    it("reads RIG_GCP_KEY from env, or a key passed in", () => {
        expect(resolveAuth("gcp", { from: AuthFrom.ENV }, { RIG_GCP_KEY: KEY })).toEqual({ key: KEY });
        expect(resolveAuth("gcp", { from: AuthFrom.KEYS, keys: { key: KEY } })).toEqual({ key: KEY });
        expect(resolveAuth("gcp")).toBeNull();
    });

    it("refuses a key that is not a service-account JSON, naming the key only", () => {
        try {
            createGcp({ region: "us-central1", auth: { from: AuthFrom.KEYS, keys: { key: "not-json-secret" } } });
            expect.unreachable();
        } catch (error) {
            expect((error as Refusal).reason).toBe(Reason.PLUGIN);
            expect((error as Refusal).message).not.toContain("not-json-secret");
        }
    });

    it("reads the key under a prefix of its own, and refuses one missing", () => {
        expect(resolveAuth("gcp", { from: AuthFrom.ENV, prefix: "EU" }, { EU_KEY: BARE_KEY })).toEqual({
            key: BARE_KEY,
        });

        expect(() => {
            return resolveAuth("gcp-eu", { from: AuthFrom.ENV }, { RIG_GCP_EU_KEY: "" });
        }).toThrow(/auth from env is missing key/);
    });

    it("refuses a key gcp does not take, and a way that is none of the three", () => {
        expect(() => {
            return resolveAuth("gcp", { from: AuthFrom.KEYS, keys: { key: BARE_KEY, secret: "s" } as never });
        }).toThrow(/has a key gcp does not take: secret/);

        expect(() => {
            return resolveAuth("gcp", { from: "vault" } as never);
        }).toThrow(/from vault is not a way: auto, env or keys/);
    });

    it("reads a service account's email and key, and its project when the JSON has one", () => {
        expect(accountOf("gcp", { key: BARE_KEY })).toEqual({ email: "a@p.iam.gserviceaccount.com", key: "pk" });

        expect(accountOf("gcp", { key: JSON.stringify({ ...JSON.parse(BARE_KEY), project_id: "kp" }) })).toEqual({
            email: "a@p.iam.gserviceaccount.com",
            key: "pk",
            project: "kp",
        });

        expect(() => {
            return accountOf("gcp", { key: JSON.stringify({ client_email: "a@p.iam.gserviceaccount.com" }) });
        }).toThrow(/client_email and private_key/);

        expect(() => {
            return accountOf("gcp", { key: JSON.stringify({ private_key: "pk" }) });
        }).toThrow(/client_email and private_key/);
    });
});
