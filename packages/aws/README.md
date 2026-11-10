# @diphyx/rig-aws

The **aws** provider for [rig](../core): Amazon Web Services (EC2).

**Status: planned.** Not written yet.

## Install

```bash
pnpm add @diphyx/rig @diphyx/rig-aws
```

## Usage

```ts
import { createRig } from "@diphyx/rig";
import { aws } from "@diphyx/rig-aws";

const cloud = aws({ region: "us-east-1" });

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

Spot Instances, with a 2-minute warning before a take-back.

## Spec

The provider follows [rig generation 1](../../spec/SPEC.md), Part 3.
