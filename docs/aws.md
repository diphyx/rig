# AWS

> Set up an AWS account for `@diphyx/rig-aws`: its keys, what they may do, its network, and a first check

The aws provider makes EC2 machines in one region, on-demand and spot. Its package: [`@diphyx/rig-aws`](https://github.com/diphyx/rig/tree/HEAD/packages/aws).

```bash
pnpm add @diphyx/rig @diphyx/rig-aws
```

## 1. The Account

An AWS account, and a region to use: EC2 is on in every account from its start.

## 2. Its Keys

The provider signs in the way the AWS SDK does by default: env vars, `~/.aws`, or the instance's own role. Where `aws sts get-caller-identity` works, `createAws()` works, with nothing to set.

For keys of its own, an IAM user with an access key, or a role's session:

```bash
export RIG_AWS_ID=AKIA...
export RIG_AWS_SECRET=...
export RIG_AWS_TOKEN=...   # a session's keys only
```

```ts
import { AuthFrom, createAws } from "@diphyx/rig-aws";

const aws = createAws({ auth: { from: AuthFrom.ENV } });
```

| Way             | Its keys                                        |
| --------------- | ----------------------------------------------- |
| `AuthFrom.AUTO` | the SDK's own: env, `~/.aws`, the instance role |
| `AuthFrom.ENV`  | `RIG_AWS_ID`, `RIG_AWS_SECRET`, `RIG_AWS_TOKEN` |
| `AuthFrom.KEYS` | `{ id, secret, token? }`, passed in             |

## 3. What They May Do

The keys need these calls, all of them the provider makes:

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "Machines",
            "Effect": "Allow",
            "Action": [
                "ec2:DescribeAvailabilityZones",
                "ec2:DescribeInstanceTypeOfferings",
                "ec2:DescribeInstanceTypes",
                "ec2:DescribeSubnets",
                "ec2:DescribeImages",
                "ec2:RunInstances",
                "ec2:CreateTags",
                "ec2:DescribeInstances",
                "ec2:StartInstances",
                "ec2:StopInstances",
                "ec2:RebootInstances",
                "ec2:TerminateInstances",
                "ec2:CreateSecurityGroup",
                "ec2:DeleteSecurityGroup",
                "ec2:DescribeSecurityGroups",
                "ec2:DescribeSecurityGroupRules",
                "ec2:AuthorizeSecurityGroupIngress",
                "ec2:RevokeSecurityGroupIngress",
                "ec2:DescribeVolumes",
                "ec2:DescribeVolumesModifications",
                "ec2:ModifyVolume"
            ],
            "Resource": "*"
        },
        {
            "Sid": "DistroImages",
            "Effect": "Allow",
            "Action": "ssm:GetParameters",
            "Resource": "arn:aws:ssm:*::parameter/aws/service/*"
        }
    ]
}
```

| Also, when                       | Allow                                                                                              |
| -------------------------------- | -------------------------------------------------------------------------------------------------- |
| a kind's machines run as a role  | `iam:PassRole` on that role: `identity` is its instance profile's name                             |
| the account's first spot machine | `iam:CreateServiceLinkedRole`, for `spot.amazonaws.com`: AWS makes `AWSServiceRoleForEC2Spot` once |

- **`ssm:GetParameters`:** a distro's newest image is AWS's own public SSM parameter, `resolve:ssm:/aws/service/...`, read by EC2 at the create.
- **`ec2:CreateTags`:** each machine is tagged at its create, and its security group after it, so `end` finds the group once the machine is gone.

## 4. Its Network

Machines go in the region's default VPC, one subnet per zone: the zones the provider offers are those with a subnet.

| Needs                                | Why                                                          | Check                                                                |
| ------------------------------------ | ------------------------------------------------------------ | -------------------------------------------------------------------- |
| a default subnet in each zone to use | the zones it offers are those with one                       | `aws ec2 describe-subnets --filters Name=default-for-az,Values=true` |
| subnets that give public IPs         | SSH, and a grid hub, reach a machine at its public IP        | `MapPublicIpOnLaunch: true` on each                                  |
| an internet gateway route            | the machine's first boot downloads, and answers from outside | the default VPC's main route table: `0.0.0.0/0` to an `igw-`         |

A default VPC with a subnet in one zone only offers that zone. Make the others, once per zone:

```bash
aws ec2 create-default-subnet --availability-zone us-east-1a
```

Or give the subnets to use, one per zone, with `extra`:

```ts
const aws = createAws({ extra: { subnets: ["subnet-0a1b...", "subnet-0c2d..."] } });
```

A machine's ports are a security group of its own, made before it with only the kind's `ports`: every other inbound port is closed, inside the VPC too. It goes with the machine.

## 5. Its Region

`region`, else `RIG_AWS_REGION`, else `AWS_REGION`, else `AWS_DEFAULT_REGION`, else `us-east-1`. Two regions are two providers, with two names:

```ts
const east = createAws({ region: "us-east-1", name: "aws-east" });
const west = createAws({ region: "us-west-2", name: "aws-west" });
```

## 6. Limits

Each account has vCPU quotas per region: one for on-demand, one for spot, per family. A create over one is `busy account`, and the core tries the next place. See them under Service Quotas, EC2: _Running On-Demand Standard instances_ and _All Standard Spot Instance Requests_.

## 7. A First Check

`check` signs in and reads the region's zones; `places` shows what each preset would try:

```ts
import { createRig } from "@diphyx/rig";
import { createAws } from "@diphyx/rig-aws";

const aws = createAws();
const kinds = [aws.presets.small({ name: "small" })];
const rig = createRig({ rig: 1, app: "try-aws", providers: [aws], kinds });

await rig.open(); // a refusal here: the keys, or the region
console.log(await rig.place.list("small")); // empty: no default subnet, or no type sold
await rig.close();
```

## 8. When It Goes Wrong

| You see                             | It is                                                                 | Do                                                               |
| ----------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------- |
| a refusal at `open`, `missing id`   | `AuthFrom.ENV` with an env var unset                                  | set `RIG_AWS_ID` and `RIG_AWS_SECRET`                            |
| a refusal at `open`, `check failed` | keys AWS refuses, or a policy without `ec2:DescribeAvailabilityZones` | `aws sts get-caller-identity` with the same keys                 |
| `UnauthorizedOperation` at a create | a call outside the policy above                                       | the message names the action: add it                             |
| every place in one zone             | the default VPC has a subnet in that zone only                        | `create-default-subnet` in the others, or `extra.subnets`        |
| `busy account`                      | a vCPU quota                                                          | ask for more under Service Quotas, or another region             |
| no SSH to a running machine         | its `ports` let in an IP other than yours                             | `from`: the IP your SSH leaves from; an HTTP proxy shows its own |

## 9. Its Machines

Every machine is tagged `rig: 1`, `rig-app`, `rig-kind` and `rig-name`, and named `<app>-<kind>-<id>`, its security group too. To list an app's machines from the CLI:

```bash
aws ec2 describe-instances --filters Name=tag:rig-app,Values=my-app Name=instance-state-name,Values=pending,running,stopped
```

What the provider does on EC2, call by call, its busy codes, distro images and types: its [README](https://github.com/diphyx/rig/tree/HEAD/packages/aws).
