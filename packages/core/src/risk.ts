import { Arch, Market } from "./enums.js";
import type { Context } from "./context.js";
import { pct } from "./parse.js";
import { type Known, placeKey } from "./store.js";
import type { Answer, Kind, Place, Risk, Seen, Shape } from "./types.js";

/* §15.3: the prior's weight, in machine-months; and the cap, in percent. */
const WEIGHT = 2;
const CAP = 50;
const MONTH = 730;
const HOUR = 3_600_000;

/** §15.2: a place's risk before the core has seen it, from its type's shape. */
export function prior(market: Market, shape: Shape | null): number {
    if (market === Market.DEMAND) {
        return 0;
    }

    if (!shape) {
        return 8;
    }

    const base = shape.gpu ? 25 : shape.cpu <= 2 ? 5 : 8;
    const size = shape.cpu <= 4 ? 1 : shape.cpu <= 16 ? 1.25 : shape.cpu <= 48 ? 1.5 : 2;
    const arch = shape.arch === Arch.ARM ? 0.8 : 1;

    return Math.min(CAP, base * size * arch);
}

function round(value: number): number {
    return Math.round(value * 10) / 10;
}

/** A type's shape, asked once per provider and type. */
export async function shapeOf(context: Context, provider: string, type: string): Promise<Shape | null> {
    const key = `${provider}/${type}`;

    if (!context.shapes.has(key)) {
        const shape = (await context.providers.get(provider)!.shape?.(type)) ?? null;

        context.shapes.set(key, shape);
    }

    return context.shapes.get(key)!;
}

/** The hours a machine has run so far. */
function hoursOf(context: Context, known: Known): number {
    return (context.clock() - known.created) / HOUR;
}

/** §15.1: a try at a place, and whether it found no room. */
export function countTry(context: Context, provider: string, place: Place, answer: Answer | null): void {
    const seen = context.store.seen(placeKey(provider, place));

    seen.tries += 1;

    if (answer && "busy" in answer) {
        seen.busy += 1;
    }

    context.store.save();
}

/** §15.1: a machine created at its place. */
export function countCreated(context: Context, known: Known): void {
    context.store.seen(placeKey(known.provider, known)).created += 1;
}

/** §15.1: a machine leaving its place, lost or ended: the hours it ran, and the loss. */
export function countLeft(context: Context, known: Known, lost: boolean): void {
    const seen = context.store.seen(placeKey(known.provider, known));

    seen.hours += Math.round(hoursOf(context, known));

    if (lost) {
        seen.lost += 1;
    }
}

/* The hours the place's running machines have run so far. */
function running(context: Context, provider: string, place: Place): number {
    const key = placeKey(provider, place);

    return context.store.machines
        .filter((known) => {
            return placeKey(known.provider, known) === key;
        })
        .reduce((hours, known) => {
            return hours + hoursOf(context, known);
        }, 0);
}

/** §15.3: the core's estimate for one place. */
export async function riskOf(context: Context, provider: string, place: Place): Promise<Risk> {
    const seen: Seen = {
        tries: 0,
        busy: 0,
        created: 0,
        lost: 0,
        hours: 0,
        ...context.store.risk[placeKey(provider, place)],
    };

    const start = prior(place.market, await shapeOf(context, provider, place.type));
    const pressure = seen.busy / (seen.tries + 5);
    const months = (seen.hours + running(context, provider, place)) / MONTH;
    const p = Math.min(CAP, start * (1 + pressure)) / 100;
    const takeback = (100 * (seen.lost + p * WEIGHT)) / (months + WEIGHT);

    return { takeback: round(takeback), pressure: round(100 * pressure), prior: round(start), seen };
}

/** §15.3: a place `risk.max` keeps: its `takeback` is not above it. */
export async function within(context: Context, kind: Kind, provider: string, place: Place): Promise<boolean> {
    if (!kind.risk) {
        return true;
    }

    return (await riskOf(context, provider, place)).takeback <= pct(kind.risk.max);
}
