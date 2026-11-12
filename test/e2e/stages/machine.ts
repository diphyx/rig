/* A few cents: one small demand machine through its whole life: boot, SSH, ports, disk, stop, start, reboot, end. Every cloud at once; a disk grow and a reboot only asked. */
import { Distro, Market, Status } from "@diphyx/rig";

import { done, fail, log, ok } from "../lib/log.ts";
import { APP, CLOUDS, providerOf, tagsOf } from "../lib/clouds.ts";
import { bootOf, myIp, ssh, sshKey } from "../lib/ssh.ts";
import { everyOf, stage, together } from "../lib/stage.ts";

const DISTRO = (process.env.RIG_E2E_DISTRO ?? Distro.UBUNTU) as Distro;
const MARK = "/tmp/rig-e2e";

export function run(): Promise<boolean> {
    const ip = myIp();

    log("this machine:", ip);

    return everyOf(CLOUDS, (cloud) => {
        const provider = providerOf(cloud);
        const kind = `box-${cloud}`;
        const kinds = [
            provider.presets.small({
                name: kind,
                distro: { name: DISTRO },
                login: { keys: [sshKey()] },
                script: [`echo ${APP} > ${MARK}`],
                ports: [{ port: 22, from: `${ip}/32` }],
                life: "1h",
            }),
        ];

        return stage(`${cloud}: one machine`, { kinds }, async (rig) => {
            const made = await rig.machine.create(kind);

            if (!made) {
                fail("no room for a small demand machine");
            }

            ok(made.market === Market.DEMAND, `created ${made.id}: ${made.type} in ${made.zone}`);

            const machine = await rig.machine.wait(made.id, Status.RUNNING);

            ok(machine.status === Status.RUNNING && machine.ip?.public, `running at ${machine.ip?.public}`);
            ok(machine.user, `login user ${machine.user}`);

            const boot = await bootOf(machine.user!, machine.ip!.public!);

            log(boot.log);
            ok(boot.exit === "0", "first boot exit 0");

            ok((await ssh(machine.user!, machine.ip!.public!, `cat ${MARK}`)).trim() === APP, "the kind's script ran");

            /* Ports: open, list, close. */
            const ports = async (): Promise<void> => {
                const rules = await rig.port.list(made.id);

                ok(
                    rules.some((rule) => {
                        return rule.port === 22;
                    }),
                    `port 22 open: ${JSON.stringify(rules)}`,
                );

                const [opened] = await rig.port.open(made.id, { port: 8080, from: `${ip}/32` });

                ok(
                    (await rig.port.list(made.id)).some((rule) => {
                        return rule.port === 8080;
                    }),
                    `port 8080 opened: ${opened!.id}`,
                );

                await rig.port.close(made.id, opened!.id!);

                ok(
                    (await rig.port.list(made.id)).every((rule) => {
                        return rule.port !== 8080;
                    }),
                    "port 8080 closed",
                );
            };

            /* Disk, stop, start, reboot: a start needs it stopped; a grow and a reboot, only asked. */
            const life = async (): Promise<void> => {
                const disk = await rig.disk.get(made.id);

                await done(`disk ${disk.gb} → ${disk.gb + 10} GB, asked`, () => {
                    return rig.disk.grow(made.id, disk.gb + 10);
                });

                await rig.machine.stop(made.id);
                ok((await rig.machine.wait(made.id, Status.STOPPED)).status === Status.STOPPED, "stopped");

                await rig.machine.start(made.id);
                const again = await rig.machine.wait(made.id, Status.RUNNING);

                ok(again.status === Status.RUNNING, `started again at ${again.ip?.public}`);

                await done("reboot, asked", () => {
                    return rig.machine.reboot(made.id);
                });
            };

            /* The two at once: ports run apart from the machine's life. */
            await together(ports(), life());

            /* End: the machine, its ports, and every machine of the kind. */
            await rig.machine.end(made.id);

            const ended = await provider.get(made.id);

            ok(!ended || ended.status === Status.ENDED, `ended: ${ended?.status ?? "gone"}`);
            ok((await provider.port!.list(made.id)).length === 0, "its ports went with it");
            ok((await provider.list(tagsOf(kind))).length === 0, `the cloud lists no ${kind} machine`);
        });
    });
}
