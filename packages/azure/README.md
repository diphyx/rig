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
import { createAzure } from "@diphyx/rig-azure";

const azure = createAzure({ region: "eastus", extra: { subscription: "..." } });

const rig = createRig({
    rig: 1,
    app: "my-app",
    providers: [azure],
    kinds: [azure.presets.small({ name: "dev" }), azure.presets.compute({ name: "worker", cpu: 8 })],
});
```

## Config

The same keys as every rig provider's factory (spec §8.2): `region`, `name`, `auth`, `identity`; azure's own go in `extra`.

## Auth

The same three ways as every rig provider (spec §8.1): `auto` (env, `az` login, or a managed identity), `env` (`RIG_AZURE_<KEY>`), or `keys`: `tenant`, `id`, `secret`. `identity` is what its machines run as.

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
