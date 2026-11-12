# @diphyx/rig-aws

The **aws** provider for [RIG](../core): Linux machines on Amazon EC2, `spot` and `demand`, in one region.

**Setup guide: [AWS](https://diphyx.github.io/rig/#/aws)**

## Install

```bash
pnpm add @diphyx/rig @diphyx/rig-aws
```

## Usage

```ts
import { createRig } from "@diphyx/rig";
import { createAws } from "@diphyx/rig-aws";

const aws = createAws(); // its region: RIG_AWS_REGION, AWS_REGION, else us-east-1

const rig = createRig({
    rig: 1,
    app: "my-app",
    providers: [aws],
    kinds: [
        aws.presets.small({ name: "dev" }), // a light box, on demand
        aws.presets.compute({ name: "worker", cpu: 8 }), // 8 vCPU, spot first, then demand
    ],
});
```

## Auth

The same three ways as every RIG provider (spec §8.1), as `AuthFrom`:

```ts
createAws(); // auto: env, `~/.aws`, or the instance role
createAws({ auth: { from: AuthFrom.ENV } }); // RIG_AWS_ID, RIG_AWS_SECRET, RIG_AWS_TOKEN?
createAws({ auth: { from: AuthFrom.KEYS, keys: { id, secret } } });
```

The keys are an access key's `id` and `secret`, and a `token` for a session. A missing key is a refusal at once, naming the key.

## Config

The same keys as every RIG provider's factory (spec §8.2); aws's own go in `extra`, and any other key is a refusal.

| Option          | Default                                                                | Is                                                                    |
| --------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `region`        | `RIG_AWS_REGION`, `AWS_REGION`, `AWS_DEFAULT_REGION`, else `us-east-1` | the AWS region                                                        |
| `name`          | `"aws"`                                                                | its name in the config; two regions are two providers, with two names |
| `auth`          | `{ from: AuthFrom.AUTO }`                                              | how it signs in: [Auth](#auth)                                        |
| `identity`      | none                                                                   | what its machines run as: an IAM instance profile's name              |
| `extra.subnets` | the default VPC's, one per zone                                        | the subnets to use, one per zone                                      |
| `extra.client`  | the SDK's client                                                       | for tests: answers in place of EC2                                    |

## What It Does on EC2

It calls EC2 with the AWS SDK's `@aws-sdk/client-ec2`.

| RIG                       | EC2                                                                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `check`                   | `DescribeAvailabilityZones`: the keys and the region work                                                                                                                                  |
| `places`                  | `DescribeInstanceTypeOfferings`, in the zones that have a subnet, every page                                                                                                               |
| `create`                  | one `RunInstances`, tagged, and named with `Name`; IMDSv2 required; the root disk always goes with the machine; a region without the distro's image is busy `type`                         |
| `spot`                    | a one-time spot request, terminated on a take-back                                                                                                                                         |
| `distro`, `image`         | the kind's `distro`: its version's newest image for the type's arch; or the entry's `image`, an AMI id, as it is                                                                           |
| `script`, `login`         | the first-boot script (spec §6.2) as `UserData`, run by cloud-init at first boot                                                                                                           |
| `get`, `list`             | `DescribeInstances`, by id, or by tag in the region, every page; `pending` until running with its public IP, in a subnet that gives one, and while EC2 has yet to find a machine just made |
| `start`, `stop`, `reboot` | `StartInstances`, `StopInstances`, `RebootInstances`; stopping a spot machine is `unsupported`                                                                                             |
| `end`                     | `TerminateInstances`, waited for, then the machine's security group deleted; groups left by machines gone earlier go too; the root disk goes with the machine                              |
| `disk.grow`, `get`        | `ModifyVolume` on the root volume; ready once the change is past `modifying`                                                                                                               |
| `port.*`                  | a security group of the machine's own, named its rig name, made before it with the kind's `ports`                                                                                          |

Its keys need the EC2 calls above, and `ec2:CreateTags` on security groups, so `end` finds a machine's group once the machine is gone.

Busy answers come from [`src/aws.json`](src/aws.json): no room in a zone (`InsufficientInstanceCapacity`, `Unsupported`, ...), in the spot market (`SpotMaxPriceTooLow`, ...), or in the account (`VcpuLimitExceeded`, ...). Any other error is thrown.

### Ports

A new machine runs in a security group of its own, made before it with only the kind's `ports`: every other inbound port is closed, inside the VPC too. `port.open` adds to them, and a failed try leaves nothing it made.

### Distro

Each version boots by its publisher's public SSM parameter, which EC2 resolves to the newest image:

| Distro | Version | arm                                                                                  | x86                                                                                  |
| ------ | ------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Ubuntu | `24.04` | `/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id` | `/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id` |
| Ubuntu | `22.04` | `/aws/service/canonical/ubuntu/server/22.04/stable/current/arm64/hvm/ebs-gp2/ami-id` | `/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id` |
| Debian | `13`    | `/aws/service/debian/release/13/latest/arm64`                                        | `/aws/service/debian/release/13/latest/amd64`                                        |
| Debian | `12`    | `/aws/service/debian/release/12/latest/arm64`                                        | `/aws/service/debian/release/12/latest/amd64`                                        |

The machine's `image` is the image it boots, by its AMI id.

## Presets

The same five presets as every RIG provider (spec §7), made by the core's preset engine from [`src/aws.json`](src/aws.json), newest generation first.

| Preset    | Size       | Default size | Default market                 | Default disk (GB) | arm                                 | x86                                                           |
| --------- | ---------- | ------------ | ------------------------------ | ----------------- | ----------------------------------- | ------------------------------------------------------------- |
| `small`   | —          | —            | `[Market.DEMAND]`              | `30`              | `t4g`                               | `t3`, `t3a`                                                   |
| `general` | `cpu`      | `2`          | `[Market.DEMAND]`              | `30 + 5 × cpu`    | `m8g`, `m7g`, `m6g`                 | `m7i`, `m7a`, `m6i`, `m6a`, `m5`                              |
| `compute` | `cpu`      | `4`          | `[Market.SPOT, Market.DEMAND]` | `30 + 5 × cpu`    | `c8g`, `c7g`, `c7gn`, `c6g`, `c6gn` | `c7i`, `c7a`, `c6i`, `c6a`, `c5`                              |
| `memory`  | `mem` (GB) | `32`         | `[Market.DEMAND]`              | `30 + mem / 2`    | `r8g`, `r7g`, `r6g`                 | `r7i`, `r7a`, `r6i`, `r6a`, `r5`                              |
| `gpu`     | `gpu`      | `t4`         | `[Market.SPOT, Market.DEMAND]` | `200`             | `g5g` (T4)                          | `g4dn` (T4), `g5` (A10), `g6` (L4), `g6e` (L40S), `p5` (H100) |

Only `name` is required; every other option has a strong default.

| Option              | Default                                                    | Is                                                                                           |
| ------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `cpu`, `mem`, `gpu` | per preset                                                 | the size, rounded up to the next one sold                                                    |
| `arch`              | `PresetArch.ANY`: Graviton first, then x86                 | `PresetArch.ARM`, `X86` or `ANY`; with your own `image`, one arch only; a `distro` fits both |
| `up`                | `0`                                                        | also try the next `up` sizes, after every type of the asked size                             |
| `image`             | —                                                          | this provider's image id: the entry's `image`, booted in place of `distro`                   |
| `disk`              | per preset, from the asked size; with `image`, the image's | GB of the boot disk                                                                          |
| `market`            | per preset                                                 | in failover order                                                                            |
| kind keys           | —                                                          | `distro`, `login`, `script`, `ports`, `worker`, `risk`, `life`, `recovers`, `tags`           |

```ts
aws.presets.compute({ name: "worker" });
// spot, then demand; 4 vCPU: c8g, c7g, c7gn, c6g, c6gn, then c7i, c7a, c6i, c6a, c5

aws.presets.compute({ name: "worker", cpu: 16, up: 1 });
// every 16 vCPU type first, then every 32 vCPU type
```

`places` gives only the types each zone sells.

## Risk

The core estimates each place's take-back risk itself (spec §15). This provider gives it each type's shape, read from the type's name and [`src/aws.json`](src/aws.json):

```ts
await aws.shape("c8g.2xlarge"); // { cpu: 8, mem: 16, arch: Arch.ARM }
await aws.shape("g6.xlarge"); // { cpu: 4, mem: 16, gpu: "l4", arch: Arch.X86 }
```

## Spot

Spot Instances, with a 2-minute warning before a take-back, seen from inside the machine. The core finds a take-back on its next round, ends the machine so nothing it held is left, and recovers it.

A full spot quota is no room in spot, not in the account: the core tries the entry's demand machines next.

## Spec

The provider follows [RIG generation 1](../../spec/SPEC.md), Part 3.
