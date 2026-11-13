# Azure

> Set up an Azure subscription for `@diphyx/rig-azure`: its role, its service principal, its network, and a first check

The azure provider makes Azure Virtual Machines in one region, on-demand and spot. Its package: [`@diphyx/rig-azure`](https://github.com/diphyx/rig/tree/HEAD/packages/azure).

**Status: draft.**

```bash
pnpm add @diphyx/rig @diphyx/rig-azure
```

## 1. The Subscription

The subscription is `extra.subscription`, else `RIG_AZURE_SUBSCRIPTION`, else `AZURE_SUBSCRIPTION_ID`. Its resource providers for machines and their networks, registered once:

```bash
az account set --subscription <subscription-id>
az provider register --namespace Microsoft.Compute
az provider register --namespace Microsoft.Network
```

## 2. What It May Do

| Scope                                       | Role          | When                                                       |
| ------------------------------------------- | ------------- | ---------------------------------------------------------- |
| the subscription                            | `Contributor` | the provider makes its resource group, `rig`, on first use |
| a resource group made before, `extra.group` | `Contributor` | everything goes in that group: a narrower role             |

In its group, the provider makes and deletes: virtual machines, their disks, network interfaces, public IPs and network security groups, and one virtual network of its own, kept.

When a kind's machines run as a user-assigned identity (`identity`), the provider also needs `Managed Identity Operator` on it. A subscription's owner has every role already.

## 3. Its Keys

The provider signs in one of three ways, its `auth`. Every way reads the subscription from [1](#1-the-subscription).

| Way                          | Where                             | It reads                                                          |
| ---------------------------- | --------------------------------- | ----------------------------------------------------------------- |
| `AuthFrom.AUTO`, the default | your computer; an Azure machine   | Azure's own: `AZURE_*` env vars, the az login, a managed identity |
| `AuthFrom.ENV`               | a server or a CI job              | `RIG_AZURE_TENANT`, `RIG_AZURE_ID`, `RIG_AZURE_SECRET`            |
| `AuthFrom.KEYS`              | an app with its own secrets store | `{ tenant, id, secret }`, passed in                               |

```ts
import { AuthFrom, createAzure } from "@diphyx/rig-azure";

createAzure(); // AUTO
createAzure({ auth: { from: AuthFrom.ENV } });
createAzure({ auth: { from: AuthFrom.KEYS, keys: { tenant, id, secret } } });
```

**On your computer, `AUTO`.** Sign the az CLI in as an account with the role above:

```bash
az login
az account set --subscription <subscription-id>
az account get-access-token # a token here: createAzure() signs in the same way
```

**On an Azure machine, `AUTO`.** Give the machine a managed identity with the role above. A user-assigned one is named by `AZURE_CLIENT_ID=<its client id>`.

**Keys of its own, `ENV` or `KEYS`.** A service principal with a secret, made with its role in one step:

```bash
az ad sp create-for-rbac --name rig --role Contributor --scopes /subscriptions/<subscription-id>
```

Its answer has the three keys: `tenant`, `appId` (the id), and `password` (the secret, shown once):

```bash
export RIG_AZURE_TENANT=<tenant>
export RIG_AZURE_ID=<appId>
export RIG_AZURE_SECRET=<password>
export RIG_AZURE_SUBSCRIPTION=<subscription-id>
```

**Env names** follow the provider's `name`: `RIG_<NAME>_TENANT`, upper-cased, `-` as `_`. A provider named `azure-eu` reads `RIG_AZURE_EU_TENANT` and `RIG_AZURE_EU_SUBSCRIPTION`; `{ from: AuthFrom.ENV, prefix: "MY_AZURE" }` reads `MY_AZURE_TENANT`.

## 4. Its Network

Everything goes in one resource group, `extra.group`, `"rig"` by default, made on first use. Its machines get a virtual network of RIG's own in that group, made on first use too, or the subnet given:

```ts
const azure = createAzure({
    extra: {
        group: "my-apps",
        subnet: "/subscriptions/<id>/resourceGroups/net/providers/Microsoft.Network/virtualNetworks/main/subnets/apps",
    },
});
```

Each machine gets a public IP, and a network security group of its own: the kind's `ports`, then a deny-all. It goes with the machine.

## 5. Its Region

`region`, else `RIG_AZURE_REGION`, else `AZURE_LOCATION`, else `AZURE_REGION`, else `eastus`. The provider offers the region's zones where each size is sold to the subscription, as Azure's resource SKUs list them.

## 6. Limits

Quotas are per region: vCPUs per size family, and _Total Regional Spot vCPUs_. A create over one is `busy account`, and the core tries the next place:

```bash
az vm list-usage --location eastus --output table
```

## 7. A First Check

```ts
import { createRig } from "@diphyx/rig";
import { createAzure } from "@diphyx/rig-azure";

const azure = createAzure();
const kinds = [azure.presets.small({ name: "small" })];
const rig = createRig({ rig: 1, app: "try-azure", providers: [azure], kinds });

await rig.open(); // a refusal here: the keys, the subscription, or the region
console.log(await rig.place.list("small"));
await rig.close();
```

## 8. When It Goes Wrong

| You see                                 | It is                                      | Do                                                                     |
| --------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------- |
| a refusal: `a subscription is required` | no subscription given                      | `RIG_AZURE_SUBSCRIPTION`, or `extra.subscription`                      |
| a refusal at `open`, `missing tenant`   | `AuthFrom.ENV` with an env var unset       | set the three `RIG_AZURE_*` keys                                       |
| `AuthorizationFailed`                   | the principal's role is on another scope   | `Contributor` on the subscription, or on `extra.group`                 |
| `MissingSubscriptionRegistration`       | a resource provider waits to be registered | `az provider register` for `Microsoft.Compute` and `Microsoft.Network` |
| `busy account`                          | a vCPU quota of the region                 | ask for more, or another region                                        |
| no SSH to a running machine             | its `ports` let in an IP other than yours  | `from`: the IP your SSH leaves from; an HTTP proxy shows its own       |

## 9. Its Machines

Every machine is tagged `rig: 1`, `rig-app`, `rig-kind` and `rig-name`, and named `<app>-<kind>-<id>`:

```bash
az vm list --resource-group rig --query "[?tags.\"rig-app\"=='my-app'].name"
```

What the provider does on Azure, call by call, its busy codes, distro images and sizes: its [README](https://github.com/diphyx/rig/tree/HEAD/packages/azure).
