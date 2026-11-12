/* Free: sign-in, each provider's check, and the places each preset would try; read only. Every cloud at once. */
import { log, ok } from "../lib/log.ts";
import { CLOUDS, providerOf } from "../lib/clouds.ts";
import { everyOf, stage } from "../lib/stage.ts";

export function run(): Promise<boolean> {
    return everyOf(CLOUDS, (cloud) => {
        const provider = providerOf(cloud);
        const kinds = [
            provider.presets.small({ name: "small" }),
            provider.presets.general({ name: "general" }),
            provider.presets.compute({ name: "compute", life: "1h" }),
        ];

        return stage(`${cloud}: check and places`, { kinds }, async (rig) => {
            for (const kind of kinds) {
                const places = await rig.place.list(kind.name);

                log(`${kind.name}: ${places.length} places; the first:`);

                for (const place of places.slice(0, 4)) {
                    log(`  ${place.market}/${place.type}/${place.zone} risk ${place.risk.takeback}%`);
                }

                ok(places.length > 0, `${kind.name} has places in the region`);
            }

            ok((await rig.machine.list()).length === 0, "the store holds no machine");
        });
    });
}
