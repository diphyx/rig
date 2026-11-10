import type { Context } from "./context.js";
import { top } from "./parse.js";
import { Refusal } from "./refusal.js";
import type { Code, Kind } from "./types.js";

/* A published rate above this is a long life's risk. */
const LONG = 10;

async function codesOf(context: Context, kind: Kind): Promise<Code[]> {
    const spot = kind.try.filter((entry) => {
        return entry.market.includes("spot");
    });

    if (spot.length === 0) {
        return [];
    }

    if (kind.life) {
        return ["spot-warn"];
    }

    for (const entry of spot) {
        const places = await context.providers.get(entry.provider)!.places(entry);
        const long = places.some((place) => {
            return place.market === "spot" && place.rate !== undefined && top(place.rate) > LONG;
        });

        if (long) {
            return ["spot-warn", "spot-long"];
        }
    }

    return ["spot-warn"];
}

/** §17: risk findings, at most once per kind and code; `refuse` turns any into a refusal. */
export async function guard(context: Context): Promise<void> {
    const found: string[] = [];

    for (const kind of context.kinds.values()) {
        for (const code of await codesOf(context, kind)) {
            found.push(`${kind.name}: ${code}`);
            context.emit("guard", { kind: kind.name, code });
        }
    }

    if (context.config.guard === "refuse" && found.length > 0) {
        throw new Refusal("guard", `guard found ${found.join(", ")}`);
    }
}
