import { describe, expect, it } from "vitest";

import { decodeCbor, encodeCbor, type CborValue } from "../src/cbor.js";
import { hex } from "./helpers.js";

const encoded = (value: CborValue): string => {
    return encodeCbor(value).toString("hex");
};

describe("cbor", () => {
    it("encodes each integer in its shortest head, and decodes it back", () => {
        const integers: [number | bigint, string][] = [
            [0, "00"],
            [23, "17"],
            [24, "1818"],
            [255, "18ff"],
            [256, "190100"],
            [65_535, "19ffff"],
            [65_536, "1a00010000"],
            [4_294_967_295, "1affffffff"],
            [4_294_967_296, "1b0000000100000000"],
            [-1, "20"],
            [-25, "3818"],
            [-500, "3901f3"],
        ];

        for (const [value, bytes] of integers) {
            expect(encoded(value), String(value)).toBe(bytes);
            expect(decodeCbor(hex(bytes)), bytes).toBe(Number(value));
        }
    });

    it("keeps an integer past the safe range as a bigint, both signs", () => {
        const big = BigInt(2) ** BigInt(64) - BigInt(1);

        expect(encoded(big)).toBe("1bffffffffffffffff");
        expect(decodeCbor(hex("1bffffffffffffffff"))).toBe(big);
        expect(encoded(-big - BigInt(1))).toBe("3bffffffffffffffff");
        expect(decodeCbor(hex("3bffffffffffffffff"))).toBe(-big - BigInt(1));
        expect(encoded(BigInt(7))).toBe("07");
    });

    it("refuses an integer past 64 bits", () => {
        expect(() => {
            return encodeCbor(BigInt(2) ** BigInt(64));
        }).toThrow("integer out of range");
    });

    it("encodes a float as a double, and decodes half, single and double floats", () => {
        expect(encoded(1.5)).toBe("fb3ff8000000000000");
        expect(decodeCbor(hex("fb3ff8000000000000"))).toBe(1.5);
        expect(decodeCbor(hex("fa3fc00000"))).toBe(1.5);
        expect(decodeCbor(hex("f93e00"))).toBe(1.5);
        expect(decodeCbor(hex("f9c400"))).toBe(-4);
        expect(decodeCbor(hex("f90001"))).toBe(2 ** -24);
        expect(decodeCbor(hex("f97c00"))).toBe(Number.POSITIVE_INFINITY);
        expect(decodeCbor(hex("f9fc00"))).toBe(Number.NEGATIVE_INFINITY);
        expect(decodeCbor(hex("f97e00"))).toBeNaN();
    });

    it("encodes text, bytes, arrays, null and booleans, and decodes them back", () => {
        const value = { text: "hé", bytes: new Uint8Array([1, 2]), list: [true, false, null] };
        const bytes = encodeCbor(value);

        expect(decodeCbor(bytes)).toEqual({ text: "hé", bytes: Buffer.from([1, 2]), list: [true, false, null] });
        expect(decodeCbor(hex("f7"))).toBeNull();
    });

    it("sorts map keys by their encoding, and leaves absent values out", () => {
        expect(encoded({ bb: 1, a: 2, c: undefined } as unknown as CborValue)).toBe("a261610262626201");
    });

    it("reads a tag as the value it holds", () => {
        expect(decodeCbor(hex("c11a514b67b0"))).toBe(1_363_896_240);
    });

    it("refuses a value it cannot encode", () => {
        expect(() => {
            return encodeCbor((() => {
                return null;
            }) as unknown as CborValue);
        }).toThrow("value cannot be encoded");
    });

    it("refuses broken input: truncated, trailing, indefinite, too long, a key not text, an unknown simple", () => {
        const broken: [string, string][] = [
            ["", "truncated"],
            ["1a0001", "truncated"],
            ["0000", "trailing bytes"],
            ["5f", "indefinite or reserved length"],
            ["9bffffffffffffffff", "length too large"],
            ["a10101", "map key is not text"],
            ["f0", "unsupported simple value"],
        ];

        for (const [bytes, message] of broken) {
            expect(() => {
                return decodeCbor(hex(bytes));
            }, bytes).toThrow(message);
        }
    });
});
