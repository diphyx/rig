import { GoogleAuth } from "google-auth-library";
import { isArray } from "radash";

import type { Account } from "./auth.js";

export type Method = "GET" | "POST" | "DELETE";

/** One Compute Engine REST call: a path under `compute/v1/`, or a full URL. */
export type Request = (method: Method, path: string, body?: unknown) => Promise<unknown>;

/** A Compute Engine error, with its code: `ZONE_RESOURCE_POOL_EXHAUSTED`, `notFound`. */
export class GceError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
        super(message);

        this.name = "GceError";
        this.code = code;
    }
}

/** A Compute Engine operation, as the API gives it. */
type Operation = {
    status?: string;
    selfLink?: string;
    error?: { errors?: { code?: string; message?: string }[] };
};

const BASE = "https://compute.googleapis.com/compute/v1/";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";

export function codeOf(error: unknown): string {
    return (error as { code?: unknown }).code !== undefined ? String((error as { code: unknown }).code) : "";
}

/* An HTTP error from Google, as a `GceError`: the first reason in its body. */
function fromHttp(error: unknown): unknown {
    const body = (error as { response?: { data?: { error?: { message?: string; errors?: { reason?: string }[] } } } })
        .response?.data?.error;

    if (!body) {
        return error;
    }

    return new GceError(body.errors?.[0]?.reason ?? "unknown", body.message ?? "");
}

/** Compute Engine over REST, signed in with Google's own library. */
export function createGce(account: Account | null, project: string | undefined, request?: Request) {
    const auth = new GoogleAuth({
        scopes: [SCOPE],
        ...(account && { credentials: { client_email: account.email, private_key: account.key } }),
        ...((project ?? account?.project) && { projectId: project ?? account?.project }),
    });

    const call: Request =
        request ??
        (async (method, path, body) => {
            const client = await auth.getClient();

            try {
                const answer = await client.request({
                    url: path.startsWith("https://") ? path : `${BASE}${path}`,
                    method,
                    ...(body !== undefined && { data: body }),
                });

                return answer.data;
            } catch (error) {
                throw fromHttp(error);
            }
        });

    let found: Promise<string> | null = null;

    return {
        call,

        /** The project: given, the key's, or the one Google's sign-in gives. */
        project(): Promise<string> {
            const known = project ?? account?.project;

            found ??= known ? Promise.resolve(known) : auth.getProjectId();

            return found;
        },

        /** An operation, waited for until done; its first error, as a `GceError`. */
        async wait(started: unknown): Promise<void> {
            let operation = started as Operation;

            while (operation.status !== "DONE") {
                operation = (await call("POST", `${operation.selfLink}/wait`)) as Operation;
            }

            const failed = operation.error?.errors?.[0];

            if (failed) {
                throw new GceError(failed.code ?? "unknown", failed.message ?? "");
            }
        },

        /** Every item of a paged list or aggregated list. */
        async all<T>(path: string, field: string): Promise<{ scope: string; item: T }[]> {
            const items: { scope: string; item: T }[] = [];
            let token: string | undefined;

            do {
                const joiner = path.includes("?") ? "&" : "?";
                const page = (await call(
                    "GET",
                    `${path}${token ? `${joiner}pageToken=${encodeURIComponent(token)}` : ""}`,
                )) as {
                    items?: T[] | Record<string, Record<string, T[] | undefined>>;
                    nextPageToken?: string;
                };

                if (isArray(page.items)) {
                    items.push(
                        ...page.items.map((item) => {
                            return { scope: "", item };
                        }),
                    );
                } else {
                    for (const [scope, group] of Object.entries(page.items ?? {})) {
                        items.push(
                            ...(group[field] ?? []).map((item) => {
                                return { scope, item };
                            }),
                        );
                    }
                }

                token = page.nextPageToken;
            } while (token);

            return items;
        },
    };
}

export type Gce = ReturnType<typeof createGce>;
