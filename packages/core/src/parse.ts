import { isString } from "radash";

const UNITS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

const DUR = /^(\d+)(s|m|h|d)$/;
const PCT = /^(\d+(?:\.\d+)?)%$/;
const RATE = /^(?:<(\d+)%|(\d+)-(\d+)%|>(\d+)%)$/;

export const NAME = /^[a-z][a-z0-9-]{0,31}$/;

export function isDur(value: unknown): value is string {
    return value === "0" || (isString(value) && DUR.test(value));
}

/** A `dur` in ms; `"0"` is never. */
export function dur(value: string): number {
    const match = DUR.exec(value);

    if (!match) {
        return Infinity;
    }

    return Number(match[1]) * UNITS[match[2] as keyof typeof UNITS];
}

export function isPct(value: unknown): value is string {
    return isString(value) && PCT.test(value);
}

export function pct(value: string): number {
    return Number(PCT.exec(value)?.[1]);
}

/** The upper bound of a take-back rate bucket, in %; `">20%"` has none. */
export function top(rate: string): number {
    const match = RATE.exec(rate);

    if (!match) {
        return Infinity;
    }

    return Number(match[1] ?? match[3] ?? Infinity);
}

export function isUint(value: unknown): value is number {
    return Number.isInteger(value) && (value as number) >= 0;
}
