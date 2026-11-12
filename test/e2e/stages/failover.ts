/* A few cents: failover for real: a type no zone sells, then spot, then demand; and from the first cloud to the second. All at once. */
import { all } from "radash";
import { Market, Status } from "@diphyx/rig";

import { fail, ok } from "../lib/log.ts";
import { CLOUDS, TYPES } from "../lib/clouds.ts";
import { everyOf, stage } from "../lib/stage.ts";

/* In one cloud: a type no zone sells has no place; spot comes first, runs, and refuses to stop. */
function within(cloud: string): Promise<boolean> {
    const types = TYPES[cloud]!;
    const kind = `hop-${cloud}`;
    const kinds = [
        {
            name: kind,
            try: [
                { provider: cloud, market: [Market.DEMAND], types: [types.none] },
                { provider: cloud, market: [Market.SPOT, Market.DEMAND], types: [types.spot, types.small] },
            ],
            life: "1h",
        },
    ];

    return stage(`${cloud}: failover in one cloud`, { kinds }, async (rig) => {
        const places = await rig.place.list(kind);

        ok(
            places.every((place) => {
                return place.type !== types.none;
            }),
            "a type no zone sells has no place",
        );

        const made = await rig.machine.create(kind);

        if (!made) {
            fail("no room in any place");
        }

        ok(made.market === Market.SPOT, `spot first: ${made.id} ${made.market}/${made.type}/${made.zone}`);
        ok((await rig.machine.wait(made.id, Status.RUNNING)).status === Status.RUNNING, "running");

        ok(
            await rig.machine.stop(made.id).then(
                () => {
                    return false;
                },
                () => {
                    return true;
                },
            ),
            "a spot machine refuses to stop",
        );
    });
}

/* The first cloud, with only a type it does not sell: the machine lands on the second. */
function across(first: string, second: string): Promise<boolean> {
    const kinds = [
        {
            name: "cross",
            try: [
                { provider: first, market: [Market.DEMAND], types: [TYPES[first]!.none] },
                { provider: second, market: [Market.DEMAND], types: [TYPES[second]!.small] },
            ],
            life: "1h",
        },
    ];

    return stage(`${first} → ${second}: failover across clouds`, { kinds }, async (rig) => {
        const made = await rig.machine.create("cross");

        ok(made?.provider === second, `landed on ${made?.provider}: ${made?.id}`);
        ok((await rig.machine.wait(made!.id, Status.RUNNING)).status === Status.RUNNING, "running");
    });
}

export async function run(): Promise<boolean> {
    const [first, second] = CLOUDS;
    const results = await all([everyOf(CLOUDS, within), ...(first && second ? [across(first, second)] : [])]);

    return results.every(Boolean);
}
