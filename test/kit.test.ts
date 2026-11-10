import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RIG = 1;

type Kit = { rig: number; area: string; cases: { id: string }[] };

const KIT = join(import.meta.dirname, "../spec/kit");

const kits = readdirSync(KIT)
    .filter((file) => {
        return file.endsWith(".json") && file !== "schema.json";
    })
    .map((file) => {
        return JSON.parse(readFileSync(join(KIT, file), "utf8")) as Kit;
    });

describe("kit", () => {
    it("is for this generation", () => {
        expect(kits.length).toBeGreaterThan(0);

        for (const kit of kits) {
            expect(kit.rig).toBe(RIG);
        }
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
