import { sleep } from "radash";

import { calls } from "./calls.js";
import * as check from "./check.js";
import { type Context, createEmitter, live } from "./context.js";
import { guard } from "./guard.js";
import { dur } from "./parse.js";
import { round } from "./rounds.js";
import { Store } from "./store.js";
import type { Config, Options } from "./types.js";

/** A core of rig generation 1, for this config. Nothing runs before `open()`. */
export function createRig(config: Config, options: Options = {}) {
    const emitter = createEmitter();
    const context: Context = {
        config,
        clock: options.clock ?? Date.now,
        sleep:
            options.sleep ??
            (async (ms: number): Promise<void> => {
                await sleep(ms);
            }),
        store: new Store(config.store ?? "./.rig"),
        providers: new Map(),
        kinds: new Map(),
        state: "new",
        orphans: new Set(),
        emit: emitter.emit,
    };

    let timer: NodeJS.Timeout | undefined;

    return {
        /** §16: check, read the store, run the first round, then a round every `every`. */
        async open(): Promise<void> {
            if (context.state !== "new") {
                return;
            }

            check.generation(config);
            check.plugins(config);
            await check.checks(config);
            check.config(config);

            context.providers = new Map(
                config.providers.map((provider) => {
                    return [provider.name, provider];
                }),
            );

            context.kinds = new Map(
                config.kinds.map((kind) => {
                    return [kind.name, kind];
                }),
            );

            await guard(context);
            context.store.load();
            context.state = "open";
            await round(context);

            const every = dur(config.every ?? "30s");

            if (options.rounds !== false && Number.isFinite(every)) {
                timer = setInterval(() => {
                    round(context).catch(() => {});
                }, every);

                timer.unref();
            }
        },

        /** §16: stop the rounds, write the store; no machine is ended. */
        async close(): Promise<void> {
            live(context);
            clearInterval(timer);
            context.store.save();
            context.state = "closed";
        },

        /** §16: a round now. */
        async round(): Promise<void> {
            live(context);
            await round(context);
        },

        /** §18: may be called before `open`, to hear `guard`. */
        on: emitter.on,

        ...calls(context),
    };
}

export type Rig = ReturnType<typeof createRig>;
