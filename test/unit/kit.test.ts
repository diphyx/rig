import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

const RIG = 1;

type Kit = { rig: number; area: string; cases: { id: string }[] };

const KIT = join(import.meta.dirname, "../../spec/kit");

const files = readdirSync(KIT).filter((file) => {
    return file.endsWith(".json") && file !== "schema.json";
});

const kits = files.map((file) => {
    return JSON.parse(readFileSync(join(KIT, file), "utf8")) as Kit;
});

/* The kit's own schema, as JSON Schema 2020-12 reads it. */
const schema = JSON.parse(readFileSync(join(KIT, "schema.json"), "utf8")) as object;

describe("kit", () => {
    it("is for this generation", () => {
        expect(kits.length).toBeGreaterThan(0);

        for (const kit of kits) {
            expect(kit.rig).toBe(RIG);
        }
    });

    it("holds to its schema, each file and each case", () => {
        const valid = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

        const wrong = files.flatMap((file, index) => {
            return valid(kits[index]) ? [] : [`${file}: ${JSON.stringify(valid.errors)}`];
        });

        expect(wrong).toEqual([]);
    });

    it("names each case by its area, once", () => {
        const ids = kits.flatMap((kit) => {
            return kit.cases.map((one) => {
                expect(one.id.startsWith(`${kit.area}/`)).toBe(true);

                return one.id;
            });
        });

        expect(new Set(ids).size).toBe(ids.length);
    });
});
