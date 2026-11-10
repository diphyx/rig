import { randomBytes } from "node:crypto";

import { Busy, Event, Market, Status } from "./enums.js";
import type { Context } from "./context.js";
import { distroOf } from "./distro.js";
import { buildBoot, userOf } from "./boot.js";
import { expandRule } from "./rules.js";
import { countCreated, countTry, within } from "./risk.js";
import type { Known } from "./store.js";
import type { Answer, Entry, Kind, Place, Spec } from "./types.js";

/** A place in failover order, with the provider that sells it. */
export type Step = Place & { provider: string };

/** §14: one entry's places, in order: market, type, zone; risky ones removed. */
export async function entrySteps(context: Context, kind: Kind, entry: Entry): Promise<Step[]> {
    const places: Place[] = [];

    for (const place of await context.providers.get(entry.provider)!.places(entry)) {
        if (await within(context, kind, entry.provider, place)) {
            places.push(place);
        }
    }

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

    return {
        name,
        tags: { ...kind.tags, rig: "1", "rig-app": app, "rig-kind": kind.name, "rig-name": name },
        ports: (kind.ports ?? []).flatMap(expandRule),
        ...(entry.image !== undefined ? { image: entry.image } : { distro: distroOf(kind.distro) }),
        ...(kind.disk !== undefined && { disk: kind.disk }),
        ...((kind.login || kind.script !== undefined) && { script: buildBoot(kind)! }),
        ...(entry.extra !== undefined && { extra: entry.extra }),
    };
}

/* §14: what a busy answer skips in its entry: the rest of its type, or of its market. */
type Skip = { market: string; type?: string } | null;

function skipped(skip: Skip, step: Step): boolean {
    return skip !== null && step.market === skip.market && (skip.type === undefined || step.type === skip.type);
}

/* One try at one place, counted and reported as `try` whatever it gives. */
async function attempt(context: Context, kind: Kind, step: Step, spec: Spec): Promise<Answer> {
    const { provider, ...place } = step;
    const tried = { kind: kind.name, place: step };

    try {
        const answer = await context.providers.get(provider)!.create(place, spec);

        countTry(context, provider, place, answer);
        context.emit(Event.TRY, { ...tried, answer });

        return answer;
    } catch (error) {
        countTry(context, provider, place, null);
        context.emit(Event.TRY, { ...tried, answer: { error } });

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
                    status: Status.PENDING,
                    market: step.market,
                    type: step.type,
                    zone: step.zone,
                    tags: spec.tags,
                    created: context.clock(),
                    provider: step.provider,
                    kind: kind.name,
                    name: spec.name,
                    ...(kind.login && { user: userOf(kind)! }),
                    chain,
                };

                store.machines.push(known);
                countCreated(context, known);
                store.save();

                return known;
            }

            /* §14: a spot quota is its own, so on a spot place `account` is the market's, and demand may still have room. */
            const busy = answer.busy === Busy.ACCOUNT && step.market === Market.SPOT ? Busy.MARKET : answer.busy;

            switch (busy) {
                case Busy.TYPE:
                    skip = { market: step.market, type: step.type };
                    break;
                case Busy.MARKET:
                    skip = { market: step.market };
                    break;
                case Busy.ACCOUNT:
                    continue entries;
            }
        }
    }

    return null;
}
