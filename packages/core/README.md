# @diphyx/rig

The rig core: create machines on any cloud, with failover.

**Status: draft.** Passes the kit; not published yet.

## What It Does

- **Failover:** tries the next place when a try finds no room: another zone, another type, `spot` → `demand`, another provider.
- **Risk:** counts how often machines are lost, per place, and drops places above a kind's `risk.max`.
- **Recover:** replaces a lost machine, up to the kind's `recovers`.
- **Guard:** warns about risky kinds when it opens.

The core has no cloud in it. Add at least one provider: official (`@diphyx/rig-aws`, `@diphyx/rig-gcp`, `@diphyx/rig-azure`) or your own.

## Install

```bash
pnpm add @diphyx/rig
```

## Usage

```ts
import { createRig } from "@diphyx/rig";

const rig = createRig({
    rig: 1,
    app: "my-app",
    providers: [provider],
    kinds: [kind],
});

await rig.open();

const machine = await rig.machine.create("worker"); // null if no room anywhere
await rig.machine.wait(machine.id, "running"); // live status and ip from the provider
```

## Spec

The core follows [rig generation 1](../../spec/SPEC.md), proven by [the kit](../../spec/kit).
