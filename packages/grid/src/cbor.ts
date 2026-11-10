import { isArray, isNumber, isObject, isString } from "radash";

export type CborValue =
    null | boolean | number | bigint | string | Uint8Array | CborValue[] | { [key: string]: CborValue };

const MAX_UINT64 = (BigInt(1) << BigInt(64)) - BigInt(1);

function head(major: number, length: number | bigint): Buffer {
    const value = BigInt(length);
    const type = major << 5;

    if (value < BigInt(24)) {
        return Buffer.from([type | Number(value)]);
    }

    if (value < BigInt(0x100)) {
        return Buffer.from([type | 24, Number(value)]);
    }

    if (value < BigInt(0x10000)) {
        const buffer = Buffer.alloc(3);
        buffer[0] = type | 25;
        buffer.writeUInt16BE(Number(value), 1);

        return buffer;
    }

    if (value < BigInt(0x100000000)) {
        const buffer = Buffer.alloc(5);
        buffer[0] = type | 26;
        buffer.writeUInt32BE(Number(value), 1);

        return buffer;
    }

    if (value > MAX_UINT64) {
        throw new Error("cbor: integer out of range");
    }

    const buffer = Buffer.alloc(9);
    buffer[0] = type | 27;
    buffer.writeBigUInt64BE(value, 1);

    return buffer;
}

function encodeInteger(value: number | bigint): Buffer {
    const integer = BigInt(value);

    return integer < BigInt(0) ? head(1, BigInt(-1) - integer) : head(0, integer);
}

function encodeNumber(value: number): Buffer {
    if (Number.isInteger(value)) {
        return encodeInteger(value);
    }

    const buffer = Buffer.alloc(9);
    buffer[0] = 0xfb;
    buffer.writeDoubleBE(value, 1);

    return buffer;
}

function encodeText(value: string): Buffer {
    const bytes = Buffer.from(value, "utf8");

    return Buffer.concat([head(3, bytes.length), bytes]);
}

/* Deterministic encoding (RFC 8949 §4.2.1): map keys sorted bytewise by their encoding; absent values left out. */
function encodeMap(value: { [key: string]: CborValue | undefined }): Buffer {
    const pairs = Object.entries(value)
        .filter(([, item]) => {
            return item !== undefined;
        })
        .map(([key, item]) => {
            return [encodeText(key), encodeCbor(item as CborValue)] as const;
        })
        .sort(([left], [right]) => {
            return Buffer.compare(left, right);
        });

    return Buffer.concat([head(5, pairs.length), ...pairs.flat()]);
}

export function encodeCbor(value: CborValue): Buffer {
    if (value === null) {
        return Buffer.from([0xf6]);
    }

    if (value === true || value === false) {
        return Buffer.from([value ? 0xf5 : 0xf4]);
    }

    if (typeof value === "bigint") {
        return encodeInteger(value);
    }

    /* Bytes before isNumber: radash's isNumber runs Number() on its value, which turns a 60 KiB chunk into a string. */
    if (value instanceof Uint8Array) {
        return Buffer.concat([head(2, value.length), value]);
    }

    if (isNumber(value)) {
        return encodeNumber(value);
    }

    if (isString(value)) {
        return encodeText(value);
    }

    if (isArray(value)) {
        return Buffer.concat([head(4, value.length), ...value.map(encodeCbor)]);
    }

    if (isObject(value)) {
        return encodeMap(value);
    }

    throw new Error("cbor: value cannot be encoded");
}

class Reader {
    offset = 0;

    constructor(readonly buffer: Buffer) {}

    take(count: number): Buffer {
        if (this.offset + count > this.buffer.length) {
            throw new Error("cbor: truncated");
        }

        const slice = this.buffer.subarray(this.offset, this.offset + count);
        this.offset += count;

        return slice;
    }

    length(info: number): number | bigint {
        if (info < 24) {
            return info;
        }

        if (info === 24) {
            return this.take(1)[0]!;
        }

        if (info === 25) {
            return this.take(2).readUInt16BE(0);
        }

        if (info === 26) {
            return this.take(4).readUInt32BE(0);
        }

        if (info === 27) {
            const value = this.take(8).readBigUInt64BE(0);

            return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
        }

        throw new Error("cbor: indefinite or reserved length");
    }

    count(info: number): number {
        const value = this.length(info);

        if (typeof value === "bigint") {
            throw new Error("cbor: length too large");
        }

        return value;
    }

    simple(info: number): CborValue {
        if (info === 20 || info === 21) {
            return info === 21;
        }

        if (info === 22 || info === 23) {
            return null;
        }

        if (info === 25) {
            return halfFloat(this.take(2).readUInt16BE(0));
        }

        if (info === 26) {
            return this.take(4).readFloatBE(0);
        }

        if (info === 27) {
            return this.take(8).readDoubleBE(0);
        }

        throw new Error("cbor: unsupported simple value");
    }

    map(info: number): { [key: string]: CborValue } {
        const size = this.count(info);

        return Object.fromEntries(
            Array.from({ length: size }, () => {
                const key = this.value();

                if (!isString(key)) {
                    throw new Error("cbor: map key is not text");
                }

                return [key, this.value()];
            }),
        );
    }

    value(): CborValue {
        const initial = this.take(1)[0]!;
        const major = initial >> 5;
        const info = initial & 0x1f;

        switch (major) {
            case 0: {
                return this.length(info);
            }
            case 1: {
                const value = this.length(info);

                return typeof value === "bigint" ? BigInt(-1) - value : -1 - value;
            }
            case 2: {
                return Buffer.from(this.take(this.count(info)));
            }
            case 3: {
                return this.take(this.count(info)).toString("utf8");
            }
            case 4: {
                return Array.from({ length: this.count(info) }, () => {
                    return this.value();
                });
            }
            case 5: {
                return this.map(info);
            }
            case 6: {
                this.length(info);

                return this.value();
            }
            default: {
                return this.simple(info);
            }
        }
    }
}

function halfFloat(bits: number): number {
    const exponent = (bits >> 10) & 0x1f;
    const fraction = bits & 0x3ff;
    const sign = bits & 0x8000 ? -1 : 1;

    if (exponent === 0) {
        return sign * 2 ** -14 * (fraction / 1024);
    }

    if (exponent === 31) {
        return fraction ? Number.NaN : sign * Number.POSITIVE_INFINITY;
    }

    return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

export function decodeCbor(buffer: Buffer): CborValue {
    const reader = new Reader(buffer);
    const value = reader.value();

    if (reader.offset !== buffer.length) {
        throw new Error("cbor: trailing bytes");
    }

    return value;
}
