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
import { createGcp } from "@diphyx/rig-gcp";

const gcp = createGcp({ region: "us-central1", extra: { project: "my-project" } });

const rig = createRig({
    rig: 1,
    app: "my-app",
    providers: [gcp],
    kinds: [gcp.presets.small({ name: "dev" }), gcp.presets.compute({ name: "worker", cpu: 8 })],
});
```

## Config

The same keys as every rig provider's factory (spec §8.2): `region`, `name`, `auth`, `identity`; gcp's own go in `extra`.

## Auth

The same three ways as every rig provider (spec §8.1): `auto` (env, gcloud login, or the machine's service account), `env` (`RIG_GCP_<KEY>`), or `keys`: `key` (a service-account JSON). `identity` is what its machines run as.

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
