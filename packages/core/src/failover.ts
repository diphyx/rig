import { randomBytes } from "node:crypto";

import { Busy, Event, Market, Status } from "./enums.js";
import type { Context } from "./context.js";
import { distroOf } from "./distro.js";
import { buildBoot, userOf } from "./boot.js";
import { workerOf } from "./workers.js";
import { expandRule, sameRule } from "./rules.js";
import { countCreated, countTry, within } from "./risk.js";
import { type Known, placeKey } from "./store.js";
import type { Answer, CreateOptions, Entry, Kind, Place, Rule, Spec } from "./types.js";

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

/* The rules, each once: a kind's port its worker needs too is opened once. */
function uniqueRules(rules: Rule[]): Rule[] {
    return rules.filter((rule, index) => {
        return (
            rules.findIndex((other) => {
                return sameRule(other, rule);
            }) === index
        );
    });
}

/* §10: what to create, with the kind's tags and the rig tags of §13. */
function specOf(context: Context, kind: Kind, entry: Entry): { spec: Spec; worker?: Known["worker"] } {
    const { app } = context.config;
    const name = `${app}-${kind.name}-${randomBytes(4).toString("hex")}`;

    /* §22.2: the worker's part of the machine: its first-boot lines, the ports it needs, and what it knows it by. */
    const plugin = kind.worker && workerOf(context.config, kind.worker);
    const setup = plugin && kind.worker && plugin.setup({ name, tags: kind.worker.tags, worker: kind.worker });
    const script = buildBoot(kind, setup);

    return {
        spec: {
            name,
            tags: { ...kind.tags, rig: "1", "rig-app": app, "rig-kind": kind.name, "rig-name": name },
            ports: uniqueRules([...(kind.ports ?? []), ...(setup?.ports ?? [])].flatMap(expandRule)),
            ...(entry.image !== undefined ? { image: entry.image } : { distro: distroOf(kind.distro) }),
            ...(kind.disk !== undefined && { disk: kind.disk }),
            ...(script !== undefined && { script }),
            ...(entry.extra !== undefined && { extra: entry.extra }),
        },
        ...(plugin &&
            setup &&
            kind.worker && { worker: { name: plugin.name, key: setup.key, tags: [...kind.worker.tags] } }),
    };
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

/** §14: one failover, for a kind already with its create's options. The first `ok` gives a known machine, counted as created; none gives `null`. */
export async function failover(
    context: Context,
    kind: Kind,
    chain: number,
    options?: CreateOptions,
): Promise<Known | null> {
    const { store } = context;

    /* §14: no place is tried twice in one failover, across its entries too. */
    const tried = new Set<string>();

    entries: for (const entry of kind.try) {
        /* What busy answers skip in this entry: a type in every market, a market for every type. */
        const types = new Set<string>();
        const markets = new Set<string>();

        for (const step of await entrySteps(context, kind, entry)) {
            const at = placeKey(step.provider, step);

            if (tried.has(at) || types.has(step.type) || markets.has(step.market)) {
                continue;
            }

            tried.add(at);

            const { spec, worker } = specOf(context, kind, entry);
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
                    ...(worker && { worker }),
                    chain,
                    ...(options && { options }),
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
                    types.add(step.type);
                    break;
                case Busy.MARKET:
                    markets.add(step.market);
                    break;
                case Busy.ACCOUNT:
                    continue entries;
            }
        }
    }

    return null;
}
