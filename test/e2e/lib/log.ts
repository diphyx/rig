/* A stage's log and its checks; stages run at once, so each line names its own. */
import { AsyncLocalStorage } from "node:async_hooks";

import { sleep } from "radash";

const SCOPE = new AsyncLocalStorage<string>();

/** `body`, its lines named `name`. */
export function scoped<T>(name: string, body: () => Promise<T>): Promise<T> {
    return SCOPE.run(name, body);
}

/** A line, with its time, and the stage's name. */
export function log(...parts: unknown[]): void {
    const scope = SCOPE.getStore();

    console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...(scope ? [`${scope} |`] : []), ...parts);
}

/** Ends the stage, with what went wrong. */
export function fail(message: string): never {
    throw new Error(`e2e: ${message}`);
}

/* How long a call the cloud took is given, before the stage goes on. */
const SETTLE = 5_000;

/** A call that holds once the cloud takes it with no error: logged, then 5 seconds, never waited on to its end. */
export async function done(message: string, call: () => Promise<unknown>): Promise<void> {
    await call();
    log("ok:", message);
    await sleep(SETTLE);
}

/** A check: logged when it holds, else the stage fails. */
export function ok(holds: unknown, message: string): void {
    if (!holds) {
        fail(message);
    }

    log("ok:", message);
}
