import { describe, expect, it } from "vitest";

import { gcp } from "./fake.js";

describe("gcp: disk", () => {
    it("refuses a machine with no boot disk, and reads a disk with no size as 0, ready", async () => {
        const { provider } = gcp({
            "GET projects/p/zones/us-central1-a/instances/bare": () => {
                return {};
            },
            "GET projects/p/zones/us-central1-a/instances/sourceless": () => {
                return { disks: [{ boot: false, source: "https://x/disks/data" }, { boot: true }] };
            },
            "GET projects/p/zones/us-central1-a/instances/x": () => {
                return { disks: [{ boot: true, source: "https://x/disks/x" }] };
            },
            "GET projects/p/zones/us-central1-a/disks/x": () => {
                return { status: "READY" };
            },
        });

        await expect(provider.disk!.grow("us-central1-a/bare", 60)).rejects.toThrow(/has no boot disk/);
        await expect(provider.disk!.get("us-central1-a/sourceless")).rejects.toThrow(/has no boot disk/);

        expect(await provider.disk!.get("us-central1-a/x")).toEqual({ gb: 0, ready: true });
    });
});
