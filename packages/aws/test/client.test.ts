import { describe, expect, it, vi } from "vitest";

import { AuthFrom, createAws } from "../src/index.js";

/* The config each EC2 client is made with; the client itself sends nothing. */
const { configs } = vi.hoisted(() => {
    return { configs: [] as Record<string, unknown>[] };
});

vi.mock("@aws-sdk/client-ec2", async (original) => {
    return {
        ...(await original<typeof import("@aws-sdk/client-ec2")>()),
        EC2Client: class {
            constructor(config: Record<string, unknown>) {
                configs.push(config);
            }

            async send(): Promise<never> {
                throw new Error("fake ec2: sends nothing");
            }
        },
    };
});

describe("aws: client", () => {
    it("makes its own EC2 client in the region, signed in with the keys, the token only when given", () => {
        configs.length = 0;

        createAws({ region: "eu-west-1" });
        createAws({ region: "us-east-1", auth: { from: AuthFrom.KEYS, keys: { id: "i", secret: "s" } } });

        createAws({
            region: "us-east-1",
            auth: { from: AuthFrom.KEYS, keys: { id: "i", secret: "s", token: "t" } },
        });

        expect(configs).toEqual([
            { region: "eu-west-1" },
            { region: "us-east-1", credentials: { accessKeyId: "i", secretAccessKey: "s" } },
            { region: "us-east-1", credentials: { accessKeyId: "i", secretAccessKey: "s", sessionToken: "t" } },
        ]);
    });
});
