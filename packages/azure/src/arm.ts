import { ClientSecretCredential, DefaultAzureCredential, type TokenCredential } from "@azure/identity";
import { sleep } from "radash";

import type { Keys } from "./auth.js";

export type Method = "GET" | "PUT" | "PATCH" | "POST" | "DELETE";

/** One Azure Resource Manager answer: its status, body and headers, in lower case. */
export type Answer = { status: number; body: unknown; headers: Record<string, string> };

/** One Azure Resource Manager REST call: a path under `management.azure.com`, or a full URL. */
export type Request = (method: Method, path: string, body?: unknown) => Promise<Answer>;

/** An Azure error, with its code: `ZonalAllocationFailed`, `ResourceNotFound`. */
export class AzureError extends Error {
    readonly code: string;
    readonly status: number;

    constructor(code: string, message: string, status = 0) {
        super(message);

        this.name = "AzureError";
        this.code = code;
        this.status = status;
    }
}

const BASE = "https://management.azure.com";
const SCOPE = "https://management.azure.com/.default";

export function codeOf(error: unknown): string {
    return (error as { code?: unknown }).code !== undefined ? String((error as { code: unknown }).code) : "";
}

/** A 404, whatever its code. */
export function gone(error: unknown): boolean {
    return (error as { status?: number }).status === 404;
}

type Failure = { error?: { code?: string; message?: string; details?: { code?: string; message?: string }[] } };

/* The deepest named error: Azure wraps the one that matters in `details`. */
function failureOf(body: unknown, status: number): AzureError {
    const error = (body as Failure)?.error;
    const inner = error?.details?.find((one) => {
        return one.code;
    });

    return new AzureError(inner?.code ?? error?.code ?? "unknown", inner?.message ?? error?.message ?? "", status);
}

/** Azure Resource Manager over REST, signed in with Azure's own library. */
export function createArm(keys: Keys | null, request?: Request) {
    const credential: TokenCredential = keys
        ? new ClientSecretCredential(keys.tenant, keys.id, keys.secret)
        : new DefaultAzureCredential();

    const call: Request =
        request ??
        (async (method, path, body) => {
            const token = await credential.getToken(SCOPE);

            if (!token) {
                throw new AzureError("AuthenticationFailed", "azure: no token from the sign-in");
            }

            const answer = await fetch(path.startsWith("https://") ? path : `${BASE}${path}`, {
                method,
                headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" },
                ...(body !== undefined && { body: JSON.stringify(body) }),
            });

            const text = await answer.text();

            return {
                status: answer.status,
                body: text ? (JSON.parse(text) as unknown) : null,
                headers: Object.fromEntries(answer.headers.entries()),
            };
        });

    /** A call; a status of 400 or more is an `AzureError`. */
    async function send(method: Method, path: string, body?: unknown): Promise<Answer> {
        const answer = await call(method, path, body);

        if (answer.status >= 400) {
            throw failureOf(answer.body, answer.status);
        }

        return answer;
    }

    return {
        send,

        /** A call, and its long-running operation waited for; its failure, as an `AzureError`. */
        async done(method: Method, path: string, body?: unknown): Promise<unknown> {
            const started = await send(method, path, body);
            const poll = started.headers["azure-asyncoperation"] ?? started.headers.location;

            /* 201 and 202 run on; anything else, or nothing to follow, is done. */
            if (!poll || (started.status !== 201 && started.status !== 202)) {
                return started.body;
            }

            for (;;) {
                const now = await send("GET", poll);
                const status = (now.body as { status?: string })?.status;

                if (status === "Failed" || status === "Canceled") {
                    throw failureOf(now.body, now.status);
                }

                if (status === "Succeeded" || (status === undefined && now.status !== 202)) {
                    return started.body;
                }

                await sleep(Number(now.headers["retry-after"] ?? 2) * 1000);
            }
        },

        /** Every item of a list, following `nextLink`. */
        async all<T>(path: string): Promise<T[]> {
            const items: T[] = [];
            let next: string | undefined = path;

            while (next) {
                const page = (await send("GET", next)).body as { value?: T[]; nextLink?: string };

                items.push(...(page.value ?? []));
                next = page.nextLink;
            }

            return items;
        },
    };
}

export type Arm = ReturnType<typeof createArm>;
