# @diphyx/rig-gcp

The **gcp** provider for [rig](../core): Google Cloud (Compute Engine).

**Status: planned.** Not written yet.

## Install

```bash
pnpm add @diphyx/rig @diphyx/rig-gcp
```

## Usage

```ts
import { createRig } from "@diphyx/rig";
import { gcp } from "@diphyx/rig-gcp";

const cloud = gcp({ project: "my-project", region: "us-central1" });

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

Spot VMs, with a 30-second warning before a take-back.

## Spec

The provider follows [rig generation 1](../../spec/SPEC.md), Part 3.
