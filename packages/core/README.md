# @diphyx/rig

The rig core: create machines on any cloud, with failover.

**Status: draft.** Passes the kit.

## Install

```bash
pnpm add @diphyx/rig @diphyx/rig-aws
```

The core and at least one provider.

## Usage

```ts
import { createRig, Event, Status } from "@diphyx/rig";
import { createAws } from "@diphyx/rig-aws";

const aws = createAws({ region: "us-east-1" });

const rig = createRig({
    rig: 1,
    app: "my-app",
    providers: [aws],
    kinds: [aws.presets.compute({ name: "worker", cpu: 8 })],
});

rig.on(Event.MACHINE_LOST, ({ machine }) => { ... });

await rig.open();

const machine = await rig.machine.create("worker"); // null if no room anywhere
await rig.machine.wait(machine.id, Status.RUNNING); // live status and ip from the provider
```

## What It Does

- **Failover:** tries the next place when a try finds no room: another zone, another type, `spot` → `demand`, another provider.
- **Risk:** estimates each place's take-back rate, from the type's shape at first and its own counts after, and drops places above a kind's `risk.max`.
- **Recover:** replaces a lost machine, up to the kind's `recovers`, after ending it so its provider removes what it left.
- **Guard:** warns about risky kinds when it opens: spot whose data a take-back loses, spot for a long life, spot on too few places.

## Disk and Ports

```ts
// at create: the boot disk's size, in GB, and the only inbound ports open; all else is closed
const kind = {
    name: "worker",
    try: [...],
    disk: 100,
    ports: [{ port: 22, from: "1.2.3.4/32" }],
}; // or aws.presets.compute({ name: "worker", disk: 100, ports: [...] })

const machine = await rig.machine.create("worker"); // a recovered one starts the same way

// later
await rig.disk.grow(machine.id, 200);
await rig.disk.wait(machine.id);
const web = await rig.port.open(machine.id, { port: 443, from: "::/0" });
await rig.port.close(machine.id, web.id);
```

Every machine starts closed to every inbound port, inside its network too, but its kind's `ports`. The provider sets them as it makes the machine, so it is never open before they are.

The same on every provider (spec §20):

| Call         | Rule                                                                                                                                    |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `disk.grow`  | only grows: a size not above the disk's now is a refusal                                                                                |
| `port.open`  | `port` and `to` from `1` to `65535`, `proto` a `Proto` (`TCP` by default), `from` an IPv4 or IPv6 CIDR; else a refusal naming the field |
| `port.open`  | a rule the machine already has is given back, not added twice                                                                           |
| `port.close` | a rule already gone is done                                                                                                             |

## Providers

Each cloud is a provider, made by its factory, the same way on every cloud (spec §8.2):

| Package             | Factory         | Cloud                  |
| ------------------- | --------------- | ---------------------- |
| `@diphyx/rig-aws`   | `createAws()`   | Amazon EC2             |
| `@diphyx/rig-gcp`   | `createGcp()`   | Google Compute Engine  |
| `@diphyx/rig-azure` | `createAzure()` | Azure Virtual Machines |

Your own is an object with the calls of spec §9; `can` names what it supports. The core gives it the same helpers the official ones use: `createPresets` for its presets, `checkFactory` for its config, `createTagMap` for its tag names.

## Presets

Every provider has the same five, made by the core's engine from the provider's own type table (spec §7):

```ts
import { createPresets, type PresetTable } from "@diphyx/rig";

const presets = createPresets("mine", table); // small, general, compute, memory, gpu
```

## Config

| Key         | Default      | Is                                             |
| ----------- | ------------ | ---------------------------------------------- |
| `rig`       | —            | the generation: `1`                            |
| `app`       | —            | this app's name; it tags every machine         |
| `providers` | —            | at least one                                   |
| `kinds`     | —            | at least one                                   |
| `guard`     | `Guard.WARN` | `Guard.WARN` or `Guard.REFUSE`                 |
| `every`     | `"30s"`      | time between rounds; `"0"`: only `rig.round()` |
| `poll`      | `"5s"`       | time between polls of a wait                   |
| `store`     | `"./.rig"`   | the folder for what the core knows             |
| `extra`     | —            | `clock`, `sleep`, `rounds`: for tests          |

## Enums

Every fixed set of values in the spec is an enum; each value is the spec's own string, so JSON and the store read the same.

| Enum         | Members                                                                                                                     |
| ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `Market`     | `SPOT`, `DEMAND`                                                                                                            |
| `Status`     | `PENDING`, `RUNNING`, `STOPPING`, `STOPPED`, `ENDING`, `ENDED`                                                              |
| `Busy`       | `ZONE`, `TYPE`, `MARKET`, `ACCOUNT`                                                                                         |
| `Arch`       | `ARM`, `X86`                                                                                                                |
| `Proto`      | `TCP`, `UDP`                                                                                                                |
| `Slot`       | `PROVIDER`, `HUB`                                                                                                           |
| `Guard`      | `WARN`, `REFUSE`                                                                                                            |
| `Finding`    | `SPOT_WARN`, `SPOT_LONG`, `SPOT_NARROW`                                                                                     |
| `Event`      | `TRY`, `MACHINE_CREATED`, `MACHINE_ENDED`, `MACHINE_LOST`, `MACHINE_RECOVERED`, `MACHINE_FAILED`, `MACHINE_ORPHAN`, `GUARD` |
| `Reason`     | `GENERATION`, `PLUGIN`, `CONFIG`, `GUARD`, `UNSUPPORTED`, `UNKNOWN`, `CLOSED`, `TIMEOUT`                                    |
| `State`      | `NEW`, `OPEN`, `CLOSED`                                                                                                     |
| `PresetName` | `SMALL`, `GENERAL`, `COMPUTE`, `MEMORY`, `GPU`                                                                              |
| `PresetArch` | `ARM`, `X86`, `ANY`                                                                                                         |

## Spec

The core follows [rig generation 1](../../spec/SPEC.md), proven by [the kit](../../spec/kit).
