# @diphyx/rig

The rig core: create machines on any cloud, with failover.

**Status: draft.** Passes the kit.

## What It Does

- **Failover:** tries the next place when a try finds no room: another zone, another type, `spot` → `demand`, another provider.
- **Risk:** estimates each place's take-back rate, from the type's shape at first and its own counts after, and drops places above a kind's `risk.max`.
- **Recover:** replaces a lost machine, up to the kind's `recovers`.
- **Guard:** warns about risky kinds when it opens: spot whose data a take-back loses, spot for a long life, spot on too few places.

Each cloud is a provider. Add at least one: official (`@diphyx/rig-aws`, `@diphyx/rig-gcp`, `@diphyx/rig-azure`) or your own.

## Install

```bash
pnpm add @diphyx/rig
```

## Usage

```ts
import { createRig, Status } from "@diphyx/rig";

const rig = createRig({
    rig: 1,
    app: "my-app",
    providers: [provider],
    kinds: [kind],
});

await rig.open();

const machine = await rig.machine.create("worker"); // null if no room anywhere
await rig.machine.wait(machine.id, Status.RUNNING); // live status and ip from the provider
```

## Enums

Every fixed set of values in the spec is an enum; each value is the spec's own string, so JSON and the store read the same.

| Enum      | Members                                                                                                                     |
| --------- | --------------------------------------------------------------------------------------------------------------------------- |
| `Market`  | `SPOT`, `DEMAND`                                                                                                            |
| `Status`  | `PENDING`, `RUNNING`, `STOPPING`, `STOPPED`, `ENDING`, `ENDED`                                                              |
| `Busy`    | `ZONE`, `TYPE`, `MARKET`, `ACCOUNT`                                                                                         |
| `Arch`    | `ARM`, `X86`                                                                                                                |
| `Proto`   | `TCP`, `UDP`                                                                                                                |
| `Slot`    | `PROVIDER`, `HUB`                                                                                                           |
| `Guard`   | `WARN`, `REFUSE`                                                                                                            |
| `Finding` | `SPOT_WARN`, `SPOT_LONG`, `SPOT_NARROW`                                                                                     |
| `Event`   | `TRY`, `MACHINE_CREATED`, `MACHINE_ENDED`, `MACHINE_LOST`, `MACHINE_RECOVERED`, `MACHINE_FAILED`, `MACHINE_ORPHAN`, `GUARD` |
| `Reason`  | `GENERATION`, `PLUGIN`, `CONFIG`, `GUARD`, `UNSUPPORTED`, `UNKNOWN`, `CLOSED`, `TIMEOUT`                                    |
| `State`   | `NEW`, `OPEN`, `CLOSED`                                                                                                     |

```ts
rig.on(Event.MACHINE_LOST, ({ machine }) => { ... });
await rig.machine.wait(id, Status.RUNNING);
```

## Spec

The core follows [rig generation 1](../../spec/SPEC.md), proven by [the kit](../../spec/kit).
