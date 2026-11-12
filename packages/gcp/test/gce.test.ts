import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthFrom, createGcp, GceError } from "../src/index.js";

/* Google's sign-in, faked: the options it is made with, its client's calls, and the project it finds. */
const google = vi.hoisted(() => {
    return {
        options: [] as Record<string, unknown>[],
        request: vi.fn(),
        projectId: vi.fn(),
    };
});

vi.mock("google-auth-library", () => {
    return {
        GoogleAuth: class {
            constructor(options: Record<string, unknown>) {
                google.options.push(options);
            }

            async getClient() {
                return { request: google.request };
            }

            getProjectId() {
                return google.projectId();
            }
        },
    };
});

const BASE = "https://compute.googleapis.com/compute/v1/";

const KEY = { client_email: "a@p.iam.gserviceaccount.com", private_key: "pk" };

/* An HTTP error as Google's client throws it, with its body. */
function http(error: Record<string, unknown>): Error {
    return Object.assign(new Error("http"), { response: { data: { error } } });
}

beforeEach(() => {
    google.options.length = 0;
    google.request.mockReset();
    google.projectId.mockReset();
});

describe("gcp: Google's own sign-in", () => {
    it("calls under the REST base, or a full URL as it is, with a body only when one is given", async () => {
        const provider = createGcp({ region: "us-central1", extra: { project: "p" } });

        google.request.mockImplementation(async ({ url }: { url: string }) => {
            return {
                data: url.endsWith("/reset")
                    ? { status: "RUNNING", selfLink: "https://x/operations/o" }
                    : { status: "DONE", disks: [{ boot: true, source: "https://x/disks/x" }] },
            };
        });

        await provider.reboot("us-central1-a/x");
        await provider.disk!.grow("us-central1-a/x", 60);

        expect(
            google.request.mock.calls.map(([options]) => {
                return options;
            }),
        ).toEqual([
            { url: `${BASE}projects/p/zones/us-central1-a/instances/x/reset`, method: "POST" },
            { url: "https://x/operations/o/wait", method: "POST" },
            { url: `${BASE}projects/p/zones/us-central1-a/instances/x`, method: "GET" },
            { url: `${BASE}projects/p/zones/us-central1-a/disks/x/resize`, method: "POST", data: { sizeGb: "60" } },
        ]);

        expect(google.options[0]).toEqual({
            scopes: ["https://www.googleapis.com/auth/cloud-platform"],
            projectId: "p",
        });
    });

    it("turns Google's HTTP error into a GceError by its first reason, and throws any other error as it is", async () => {
        const provider = createGcp({ region: "us-central1", extra: { project: "p" } });

        google.request.mockRejectedValueOnce(http({ message: "gone", errors: [{ reason: "notFound" }] }));

        expect(await provider.get("us-central1-a/x")).toBeNull();

        google.request.mockRejectedValueOnce(http({}));

        const unknown = await provider.get("us-central1-a/x").catch((error: unknown) => {
            return error;
        });

        expect(unknown).toBeInstanceOf(GceError);
        expect(unknown).toMatchObject({ code: "unknown", message: "" });

        google.request.mockRejectedValueOnce(new Error("socket hang up"));

        await expect(provider.get("us-central1-a/x")).rejects.toThrow("socket hang up");
    });

    it("signs in as the service account, in its key's project", async () => {
        const provider = createGcp({
            region: "us-central1",
            auth: { from: AuthFrom.KEYS, keys: { key: JSON.stringify({ ...KEY, project_id: "kp" }) } },
        });

        google.request.mockResolvedValue({ data: { status: "DONE" } });

        await provider.start!("us-central1-a/x");

        expect(google.options[0]).toEqual({
            scopes: ["https://www.googleapis.com/auth/cloud-platform"],
            credentials: { client_email: "a@p.iam.gserviceaccount.com", private_key: "pk" },
            projectId: "kp",
        });

        expect(google.request.mock.calls[0]![0]).toMatchObject({
            url: `${BASE}projects/kp/zones/us-central1-a/instances/x/start`,
        });
    });

    it("asks Google's sign-in for the project once, when neither the config nor the key has one", async () => {
        const provider = createGcp({
            region: "us-central1",
            auth: { from: AuthFrom.KEYS, keys: { key: JSON.stringify(KEY) } },
        });

        google.projectId.mockResolvedValue("found");
        google.request.mockResolvedValue({ data: { status: "DONE" } });

        await provider.start!("us-central1-a/x");
        await provider.reboot("us-central1-a/x");

        expect(google.options[0]).not.toHaveProperty("projectId");
        expect(google.projectId).toHaveBeenCalledTimes(1);

        expect(google.request.mock.calls[1]![0]).toMatchObject({
            url: `${BASE}projects/found/zones/us-central1-a/instances/x/reset`,
        });
    });
});
