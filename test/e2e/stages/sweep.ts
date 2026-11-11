/* The safety net: every machine in each cloud tagged with the app, ended at once, whatever the stores hold. Run it after a failed stage. */
import { all } from "radash";

import { log } from "../lib/log.ts";
import { APP, CLOUDS, providerOf, TAGS } from "../lib/clouds.ts";

export async function run(): Promise<boolean> {
    await all(
        CLOUDS.map(async (cloud) => {
            const provider = providerOf(cloud);
            const machines = await provider.list(TAGS);

            log(`${cloud}: ${machines.length} ${APP} machines`);

            await all(
                machines.map((machine) => {
                    log("end", machine.id, machine.status, machine.type, machine.zone);

                    return provider.end(machine.id);
                }),
            );
        }),
    );

    log("swept");

    return true;
}
