import { ClientSecretCredential, DefaultAzureCredential } from "@azure/identity";
import { describe, expect, it, vi } from "vitest";

import { AuthFrom, createAzure } from "../src/index.js";
import { cleanEach, ok, VM, NETWORK, azure, PLACE, SPEC } from "./fake.js";

cleanEach();

describe("azure: sign-in and REST", () => {
    it("signs in with a service principal's keys and sends each call to management.azure.com with its token", async () => {
        vi.spyOn(ClientSecretCredential.prototype, "getToken").mockResolvedValue({
            token: "tok",
            expiresOnTimestamp: Date.now() + 60_000,
        });

        const sent: { url: string; method?: string; auth?: string; body?: string }[] = [];

        vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
            sent.push({
                url,
                method: init.method,
                auth: (init.headers as Record<string, string>).authorization,
                ...(init.body !== undefined && { body: String(init.body) }),
            });

            if (url.includes("virtualMachines/box")) {
                return Response.json({
                    properties: { storageProfile: { osDisk: { managedDisk: { id: "/disks/os" } } } },
                });
            }

            if (url.startsWith("https://management.azure.com/disks/os")) {
                return new Response("", { status: 202, headers: { location: "https://op.azure.com/1" } });
            }

            return Response.json({ status: "Succeeded" });
        });

        const provider = createAzure({
            region: "eastus",
            auth: { from: AuthFrom.KEYS, keys: { tenant: "t", id: "i", secret: "s" } },
            extra: { subscription: "s" },
        });

        await provider.disk!.grow("box", 60);

        expect(sent).toEqual([
            {
                url: `https://management.azure.com${VM}/box?api-version=2024-07-01`,
                method: "GET",
                auth: "Bearer tok",
            },
            {
                url: "https://management.azure.com/disks/os?api-version=2024-03-02",
                method: "PATCH",
                auth: "Bearer tok",
                body: JSON.stringify({ properties: { diskSizeGB: 60 } }),
            },
            { url: "https://op.azure.com/1", method: "GET", auth: "Bearer tok" },
        ]);
    });

    it("signs in with Azure's own sign-in by default, and a sign-in with no token is an AzureError", async () => {
        const token = vi.spyOn(DefaultAzureCredential.prototype, "getToken").mockResolvedValue(null as never);

        await expect(azure({}, { request: undefined }).provider.check!()).rejects.toMatchObject({
            name: "AzureError",
            code: "AuthenticationFailed",
        });

        expect(token).toHaveBeenCalledWith("https://management.azure.com/.default");
    });

    it("makes a failure with no error in its body an unknown AzureError, with its status", async () => {
        const { provider } = azure({
            "GET /subscriptions/s": () => {
                return { status: 500, body: null, headers: {} };
            },
        });

        await expect(provider.check!()).rejects.toMatchObject({
            name: "AzureError",
            code: "unknown",
            message: "",
            status: 500,
        });
    });

    it("follows an operation while it answers 202, waiting its retry-after, else 2 seconds", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout"] });

        let polls = 0;

        const { provider } = azure({
            ...NETWORK,
            [`PUT ${VM}/app-w-0a1b2c3d`]: () => {
                return { status: 201, body: { name: "app-w-0a1b2c3d" }, headers: { location: "https://op/2" } };
            },
            "GET https://op/2": () => {
                polls += 1;

                if (polls === 1) {
                    return { status: 202, body: { status: "InProgress" }, headers: { "retry-after": "1" } };
                }

                return polls === 2 ? { status: 202, body: null, headers: {} } : ok(null);
            },
        });

        const answer = provider.create(PLACE, SPEC);

        await vi.advanceTimersByTimeAsync(1000);
        expect(polls).toBe(2);

        await vi.advanceTimersByTimeAsync(2000);
        expect(await answer).toEqual({ ok: { id: "app-w-0a1b2c3d" } });
        expect(polls).toBe(3);
    });

    it("throws a canceled operation as its error, and an error with no code as it is", async () => {
        const canceled = azure({
            ...NETWORK,
            [`PUT ${VM}/app-w-0a1b2c3d`]: () => {
                return { status: 202, body: {}, headers: { "azure-asyncoperation": "https://op/3" } };
            },
            "GET https://op/3": () => {
                return ok({ status: "Canceled", error: { code: "OperationCanceled", message: "canceled" } });
            },
            [`DELETE ${VM}/app-w-0a1b2c3d`]: () => {
                return ok();
            },
        });

        await expect(canceled.provider.create(PLACE, SPEC)).rejects.toMatchObject({ code: "OperationCanceled" });

        const broken = azure({
            ...NETWORK,
            [`PUT ${VM}/app-w-0a1b2c3d`]: () => {
                throw new Error("socket hang up");
            },
            [`DELETE ${VM}/app-w-0a1b2c3d`]: () => {
                return ok();
            },
        });

        await expect(broken.provider.create(PLACE, SPEC)).rejects.toThrow("socket hang up");
    });

    it("reads a page with no value as no items", async () => {
        const { provider } = azure({
            [`GET ${VM}`]: () => {
                return ok({});
            },
        });

        expect(await provider.list({})).toEqual([]);
    });
});
