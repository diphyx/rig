import { describe, expect, it } from "vitest";

import { cleanEach, ok, VM, azure } from "./fake.js";

cleanEach();

describe("azure: disk", () => {
    it("throws for a machine with no managed OS disk, and reads a disk with no size as 0, ready once it succeeded", async () => {
        const { provider, calls } = azure({
            [`GET ${VM}/plain`]: () => {
                return ok({});
            },
            [`GET ${VM}/box`]: () => {
                return ok({ properties: { storageProfile: { osDisk: { managedDisk: { id: "/disks/os?v=1" } } } } });
            },
            "GET /disks/os": () => {
                return ok({ properties: { provisioningState: "Succeeded" } });
            },
        });

        await expect(provider.disk!.grow("plain", 60)).rejects.toThrow(/plain has no managed OS disk/);
        expect(await provider.disk!.get("box")).toEqual({ gb: 0, ready: true });
        expect(calls.at(-1)!.path).toBe("/disks/os?v=1&api-version=2024-03-02");
    });
});
