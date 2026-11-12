/* A few cents: a take-back, made by ending the machine behind the core's back; then a lost store, its machine found again by its tags. Every cloud at once. */
import { tryit } from "radash";

import { Event, type Kind, Market, Status } from "@diphyx/rig";

import { fail, log, ok } from "../lib/log.ts";
import { CLOUDS, providerOf, tagsOf, TYPES } from "../lib/clouds.ts";
import { coreOf, everyOf, stage, together } from "../lib/stage.ts";

export function run(): Promise<boolean> {
    return everyOf(CLOUDS, (cloud) => {
        const provider = providerOf(cloud);
        const kind = `keep-${cloud}`;
        const name = `${cloud}: lost, recovered, store lost, adopted`;

        const kinds: Kind[] = [
            {
                name: kind,
                try: [{ provider: cloud, market: [Market.DEMAND], types: [TYPES[cloud]!.small] }],
                life: "1h",
                recovers: 1,
            },
        ];

        return stage(name, { kinds }, async (rig) => {
            const made = await rig.machine.create(kind);

            if (!made) {
                fail("no room for a small demand machine");
            }

            await rig.machine.wait(made.id, Status.RUNNING);
            log("ending", made.id, "behind the core's back");
            await provider.end(made.id);

            let recovered = "";

            rig.on(Event.MACHINE_RECOVERED, ({ machine }) => {
                recovered = machine.id;
            });

            await rig.round();
            ok(recovered && recovered !== made.id, `lost ${made.id}, recovered as ${recovered}`);
            ok((await rig.machine.list()).length === 1, "the store holds only the new one");

            /* The store is gone: a new core on an empty store finds the new machine by its tags and adopts it. */
            await rig.close();

            const again = coreOf(name, { kinds });

            try {
                await again.open();

                const held = await again.machine.list();

                ok(
                    held.some((machine) => {
                        return machine.id === recovered;
                    }),
                    `adopted ${recovered}`,
                );
            } finally {
                await together(
                    ...(await provider.list(tagsOf(kind))).map((machine) => {
                        log("cleanup: end", machine.id);

                        return provider.end(machine.id);
                    }),
                );

                await tryit(again.close)();
            }
        });
    });
}
