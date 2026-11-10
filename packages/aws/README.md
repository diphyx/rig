# @diphyx/rig-aws

The **aws** provider for [rig](../core): Amazon EC2, `spot` and `demand`, in one region.

**Status: draft.** Tested against a fake EC2 client.

## Install

```bash
pnpm add @diphyx/rig @diphyx/rig-aws
```

## Usage

```ts
import { createRig } from "@diphyx/rig";
import { createAws } from "@diphyx/rig-aws";

const aws = createAws({ region: "us-east-1" });

const rig = createRig({
    rig: 1,
    app: "my-app",
    providers: [aws],
    kinds: [aws.presets.small({ name: "dev" }), aws.presets.compute({ name: "worker", cpu: 8 })],
});
```

## Auth

The same three ways as every rig provider (spec §8.1), as `AuthFrom`:

```ts
createAws({ region: "us-east-1" }); // auto: env, ~/.aws, or the instance role
createAws({ region: "us-east-1", auth: { from: AuthFrom.ENV } }); // RIG_AWS_ID, RIG_AWS_SECRET, RIG_AWS_TOKEN?
createAws({ region: "us-east-1", auth: { from: AuthFrom.KEYS, keys: { id, secret } } });
```

A missing key is a refusal at once, naming the key.

## Config

The same keys as every rig provider's factory (spec §8.2); aws's own go in `extra`, and any other key is a refusal.

| Option          | Default                         | Is                                                                                                                                                                                                     |
| --------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `region`        | —                               | the AWS region                                                                                                                                                                                         |
| `name`          | `"aws"`                         | the provider's name; two regions are two providers, two names                                                                                                                                          |
| `auth`          | `{ from: "auto" }`              | how it signs in, the same on every rig provider: `auto` (the SDK's chain: env, `~/.aws`, instance role), `env` (`RIG_AWS_ID`, `RIG_AWS_SECRET`, `RIG_AWS_TOKEN`), or `keys` (`{ id, secret, token? }`) |
| `identity`      | none                            | what its machines run as: an IAM instance profile's name                                                                                                                                               |
| `extra.subnets` | the default VPC's, one per zone | the subnets to use, one per zone                                                                                                                                                                       |
| `extra.key`     | none                            | an EC2 key pair for every machine                                                                                                                                                                      |

## What It Does on EC2

| rig                       | EC2                                                                                                                               |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `check`                   | `DescribeAvailabilityZones`: the keys and the region work                                                                         |
| `places`                  | `DescribeInstanceTypeOfferings`, in zones that have a subnet                                                                      |
| `create`                  | one `RunInstances`, tagged (and named, with `Name`); `spot` is a one-time request that terminates on a take-back; IMDSv2 required |
| image                     | the kind's, or Ubuntu 24.04 (arm64 or x86_64, by type) from Canonical's public SSM parameter                                      |
| `get`, `list`             | `DescribeInstances`, by id or by tag, every page                                                                                  |
| `start`, `stop`, `reboot` | `StartInstances`, `StopInstances`, `RebootInstances`; stopping a spot machine is `unsupported`                                    |
| `end`                     | takes the machine's own security group off and deletes it, then `TerminateInstances`; the root disk goes with the machine         |
| `disk.grow`, `get`        | `ModifyVolume` on the root volume; ready once the change is past `modifying`                                                      |
| `port.*`                  | a security group of the machine's own, made on the first `port.open`                                                              |

Busy answers come from [`src/aws.json`](src/aws.json): no room in a zone (`InsufficientInstanceCapacity`, `Unsupported`, ...), in the spot market (`SpotMaxPriceTooLow`, ...), or in the account (`VcpuLimitExceeded`, ...). Any other error is thrown.

## Presets

| Preset    | Size     | Default size | Default market       |
| --------- | -------- | ------------ | -------------------- |
| `small`   | —        | —            | `["demand"]`         |
| `general` | `cpu`    | `2`          | `["demand"]`         |
| `compute` | `cpu`    | `4`          | `["spot", "demand"]` |
| `memory`  | `mem` GB | `32`         | `["demand"]`         |
| `gpu`     | `gpu`    | `t4`         | `["spot", "demand"]` |

Only `name` is required; every other option has a strong default.

| Option              | Default                                     | Is                                                                |
| ------------------- | ------------------------------------------- | ----------------------------------------------------------------- |
| `cpu`, `mem`, `gpu` | per preset                                  | the size, rounded up to the next one sold                         |
| `arch`              | `"any"`: Graviton first, then Intel and AMD | `"arm"`, `"x86"` or `"any"`; with your own `image`, one arch only |
| `up`                | `0`                                         | also try the next `up` sizes, after every type of the asked size  |
| `market`            | per preset                                  | in failover order                                                 |
| kind keys           | —                                           | `image`, `disk`, `script`, `risk`, `life`, `recovers`, `tags`     |

```ts
aws.presets.compute({ name: "worker" });
// spot then demand, 4 vCPU: c8g, c7g, c7gn, c6g, c6gn, then c7i, c7a, c6i, c6a, c5

aws.presets.compute({ name: "worker", cpu: 16, up: 1 });
// every 16 vCPU type first, then every 32 vCPU type
```

The type lists are in [`src/aws.json`](src/aws.json), newest generation first. `places` gives only the types each zone sells.

## Spot

Spot Instances: AWS gives a 2-minute warning before a take-back, seen only from inside the machine; until rig's hub exists, the core finds a take-back on its next round.

## Risk

The core estimates each place's take-back risk itself (spec §15). This provider gives it each type's shape, read from the type's name and [`src/aws.json`](src/aws.json):

```ts
await aws.shape("c8g.2xlarge"); // { cpu: 8, mem: 16, arch: Arch.ARM }
await aws.shape("g6.xlarge"); // { cpu: 4, mem: 16, gpu: "l4", arch: Arch.X86 }
```

## Spec

The provider follows [rig generation 1](../../spec/SPEC.md), Part 3.
