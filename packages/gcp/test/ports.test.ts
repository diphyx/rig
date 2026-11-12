import { describe, expect, it } from "vitest";

import { Protocol } from "@diphyx/rig";

import { GceError } from "../src/index.js";

import { gcp } from "./fake.js";

describe("gcp: ports", () => {
    it("opens a port range by its protocol, and a single port when its end is its start", async () => {
        const { provider, calls } = gcp({});

        const range = await provider.port!.open("us-central1-a/x", {
            port: 8000,
            to: 8100,
            protocol: Protocol.UDP,
            from: "1.2.3.4/32",
        });

        await provider.port!.open("us-central1-a/x", { port: 22, to: 22, from: "1.2.3.4/32" });

        const allowed = calls
            .filter((one) => {
                return one.method === "POST";
            })
            .map((one) => {
                return one.body?.allowed;
            });

        expect(allowed).toEqual([
            [{ IPProtocol: "udp", ports: ["8000-8100"] }],
            [{ IPProtocol: "tcp", ports: ["22"] }],
        ]);

        expect(range).toMatchObject({ port: 8000, to: 8100, id: expect.stringMatching(/^x-[0-9a-f]{8}$/) });
    });

    it("lists a range by its two ends, and a bare rule as port 0 over tcp from nowhere", async () => {
        const { provider } = gcp({
            "GET projects/p/global/firewalls": () => {
                return {
                    items: [
                        {
                            name: "x-aaaa",
                            allowed: [{ IPProtocol: "udp", ports: ["8000-8100"] }],
                            sourceRanges: ["::/0"],
                        },
                        { allowed: [{}] },
                    ],
                };
            },
        });

        expect(await provider.port!.list("us-central1-a/x")).toEqual([
            { id: "x-aaaa", port: 8000, to: 8100, protocol: "udp", from: "::/0" },
            { id: "", port: 0, protocol: "tcp", from: "" },
        ]);
    });

    it("reads every page of rules, joining its page token to the filter", async () => {
        const { provider, calls } = gcp({
            "GET projects/p/global/firewalls": (_body, path) => {
                return path.includes("pageToken=")
                    ? { items: [{ name: "x-bbbb", allowed: [{ IPProtocol: "tcp", ports: ["80"] }] }] }
                    : {
                          items: [{ name: "x-aaaa", allowed: [{ IPProtocol: "tcp", ports: ["22"] }] }],
                          nextPageToken: "t 1",
                      };
            },
        });

        expect(
            (await provider.port!.list("us-central1-a/x")).map((rule) => {
                return rule.id;
            }),
        ).toEqual(["x-aaaa", "x-bbbb"]);

        expect(calls[1]!.path).toMatch(/\?filter=.*&pageToken=t%201$/);
    });

    it("closes a rule already gone, and throws any other failure", async () => {
        const { provider } = gcp({
            "DELETE projects/p/global/firewalls/gone": () => {
                throw new GceError("notFound", "");
            },
            "DELETE projects/p/global/firewalls/held": () => {
                throw new GceError("resourceInUseByAnotherResource", "held");
            },
        });

        await provider.port!.close("us-central1-a/x", "gone");
        await expect(provider.port!.close("us-central1-a/x", "held")).rejects.toThrow("held");
    });
});
