import { randomBytes } from "node:crypto";

import type { Context } from "./context.js";
import { pct, top } from "./parse.js";
import { type Known, placeKey } from "./store.js";
import type { Answer, Entry, Kind, Place, Spec } from "./types.js";

/** A place in failover order, with the provider that sells it. */
export type Step = Place & { provider: string };

/* §15: a place above `risk.max`, by its published rate or the core's own count. */
function risky(context: Context, kind: Kind, provider: string, place: Place): boolean {
    if (!kind.risk) {
        return false;
    }

    const max = pct(kind.risk.max);
    const seen = context.store.risk[placeKey(provider, place)];

    if (place.rate && top(place.rate) > max) {
        return true;
    }

    return seen !== undefined && seen.created >= 10 && (seen.lost / seen.created) * 100 > max;
}

/** §14: one entry's places, in order: market, type, zone; risky ones removed. */
export async function entrySteps(context: Context, kind: Kind, entry: Entry): Promise<Step[]> {
    const places = (await context.providers.get(entry.provider)!.places(entry)).filter((place) => {
        return !risky(context, kind, entry.provider, place);
    });

    return entry.market.flatMap((market) => {
        return entry.types.flatMap((type) => {
            return places
                .filter((place) => {
                    return place.market === market && place.type === type;
                })
                .sort((a, b) => {
                    return a.zone.localeCompare(b.zone);
                })
                .map((place) => {
                    return { ...place, provider: entry.provider };
                });
        });
    });
}

/* §10: what to create, with the kind's tags and the rig tags of §13. */
function specOf(context: Context, kind: Kind, entry: Entry): Spec {
    const { app } = context.config;
    const name = `${app}-${kind.name}-${randomBytes(4).toString("hex")}`;
    const image = entry.image ?? kind.image;

    return {
        name,
        tags: { ...kind.tags, rig: "1", "rig-app": app, "rig-kind": kind.name, "rig-name": name },
        ...(image !== undefined && { image }),
        ...(kind.disk !== undefined && { disk: kind.disk }),
        ...(kind.script !== undefined && { script: kind.script }),
        ...(entry.extra !== undefined && { extra: entry.extra }),
    };
}

/* §14: what a busy answer skips in its entry: the rest of its type, or of its market. */
type Skip = { market: string; type?: string } | null;

function skipped(skip: Skip, step: Step): boolean {
    return skip !== null && step.market === skip.market && (skip.type === undefined || step.type === skip.type);
}

/* One try at one place, reported as `try` whatever it gives. */
async function attempt(context: Context, kind: Kind, step: Step, spec: Spec): Promise<Answer> {
    const { provider, ...place } = step;
    const tried = { kind: kind.name, place: step };

    try {
        const answer = await context.providers.get(provider)!.create(place, spec);

        context.emit("try", { ...tried, answer });

        return answer;
    } catch (error) {
        context.emit("try", { ...tried, answer: { error } });

        throw error;
    }
}

/** §14: one failover. The first `ok` gives a known machine, counted as created; none gives `null`. */
export async function failover(context: Context, kind: Kind, chain: number): Promise<Known | null> {
    const { store } = context;

    entries: for (const entry of kind.try) {
        let skip: Skip = null;

        for (const step of await entrySteps(context, kind, entry)) {
            if (skipped(skip, step)) {
                continue;
            }

            const spec = specOf(context, kind, entry);
            const answer = await attempt(context, kind, step, spec);

            if ("ok" in answer) {
                const known: Known = {
                    id: answer.ok.id,
                    status: "pending",
                    market: step.market,
                    type: step.type,
                    zone: step.zone,
                    tags: spec.tags,
                    created: context.clock(),
                    provider: step.provider,
                    kind: kind.name,
                    name: spec.name,
                    chain,
                };

                store.machines.push(known);
                store.seen(placeKey(step.provider, step)).created += 1;
                store.save();

                return known;
            }

            switch (answer.busy) {
                case "type":
                    skip = { market: step.market, type: step.type };
                    break;
                case "market":
                    skip = { market: step.market };
                    break;
                case "account":
                    continue entries;
            }
        }
    }

    return null;
}
