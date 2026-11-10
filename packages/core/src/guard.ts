import { Event, Finding, Guard, Market, Reason } from "./enums.js";
import type { Context } from "./context.js";
import { riskOf } from "./risk.js";
import { Refusal } from "./refusal.js";
import type { Kind } from "./types.js";

/* A spot place's `takeback` above this is a long life's risk; fewer spot places than this is narrow. */
const LONG = 10;
const NARROW = 3;

async function codesOf(context: Context, kind: Kind): Promise<Finding[]> {
    const spot = kind.try.filter((entry) => {
        return entry.market.includes(Market.SPOT);
    });

    if (spot.length === 0) {
        return [];
    }

    const places = [];

    for (const entry of spot) {
        for (const place of await context.providers.get(entry.provider)!.places(entry)) {
            if (place.market === Market.SPOT) {
                places.push({ provider: entry.provider, place });
            }
        }
    }

    const codes: Finding[] = [Finding.SPOT_WARN];

    if (!kind.life) {
        for (const { provider, place } of places) {
            if ((await riskOf(context, provider, place)).takeback > LONG) {
                codes.push(Finding.SPOT_LONG);

                break;
            }
        }
    }

    if (places.length < NARROW) {
        codes.push(Finding.SPOT_NARROW);
    }

    return codes;
}

/** §17: risk findings, at most once per kind and code; `refuse` turns any into a refusal. */
export async function guard(context: Context): Promise<void> {
    const found: string[] = [];

    for (const kind of context.kinds.values()) {
        for (const code of await codesOf(context, kind)) {
            found.push(`${kind.name}: ${code}`);
            context.emit(Event.GUARD, { kind: kind.name, code });
        }
    }

    if (context.config.guard === Guard.REFUSE && found.length > 0) {
        throw new Refusal(Reason.GUARD, `guard found ${found.join(", ")}`);
    }
}
