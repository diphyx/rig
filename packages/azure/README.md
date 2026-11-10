# @diphyx/rig-azure

The **azure** provider for [rig](../core): Microsoft Azure (Virtual Machines).

**Status: planned.** Not written yet.

## Install

```bash
pnpm add @diphyx/rig @diphyx/rig-azure
```

## Usage

```ts
import { createRig } from "@diphyx/rig";
import { azure } from "@diphyx/rig-azure";

const cloud = azure({ subscription: "...", region: "eastus" });

const rig = createRig({
    rig: 1,
    app: "my-app",
    providers: [cloud],
    kinds: [cloud.small({ name: "dev" }), cloud.compute({ name: "worker", cpu: 8 })],
});
```

## Presets

| Preset    | For                     | Default market       |
| --------- | ----------------------- | -------------------- |
| `small`   | a light, long-lived box | `["demand"]`         |
| `general` | balanced cpu and memory | `["demand"]`         |
| `compute` | cpu-heavy work          | `["spot", "demand"]` |
| `memory`  | memory-heavy work       | `["demand"]`         |
| `gpu`     | gpu work                | `["spot", "demand"]` |

Only `name` is required. The type lists come from this provider's data file.

## Spot

Spot Virtual Machines, with a 30-second warning before a take-back.

## Spec

The provider follows [rig generation 1](../../spec/SPEC.md), Part 3.
