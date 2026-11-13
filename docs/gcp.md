# GCP

> Set up a Google Cloud project for `@diphyx/rig-gcp`: its roles, its key, its network, and a first check

The gcp provider makes Compute Engine machines in one region, on-demand and spot. Its package: [`@diphyx/rig-gcp`](https://github.com/diphyx/rig/tree/HEAD/packages/gcp).

```bash
pnpm add @diphyx/rig @diphyx/rig-gcp
```

## 1. The Project

A project with billing, and the Compute Engine API on:

```bash
gcloud services enable compute.googleapis.com --project my-project
```

The project is `extra.project`, else the key's `project_id`, else the one Google's sign-in gives.

## 2. What It May Do

| Role                             | For                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------- |
| `roles/compute.instanceAdmin.v1` | machines and their disks: create, get, list, start, stop, reset, delete, resize |
| `roles/compute.securityAdmin`    | each machine's firewall rules: create, list, delete                             |
| `roles/iam.serviceAccountUser`   | only when a kind's machines run as a service account: `identity`                |

Give them to whoever the provider signs in as, its member. A project's owner has them already.

| Signs in as         | Member                                                  |
| ------------------- | ------------------------------------------------------- |
| your Google account | `user:you@example.com`                                  |
| a service account   | `serviceAccount:rig@my-project.iam.gserviceaccount.com` |

```bash
for role in roles/compute.instanceAdmin.v1 roles/compute.securityAdmin; do
    gcloud projects add-iam-policy-binding my-project --member <member> --role "$role"
done
```

Distro images come from Google's public image projects, `ubuntu-os-cloud` and `debian-cloud`, which every project may read.

## 3. Its Keys

The provider signs in one of three ways, its `auth`:

| Way                          | Where                                   | It reads                                                                        |
| ---------------------------- | --------------------------------------- | ------------------------------------------------------------------------------- |
| `AuthFrom.AUTO`, the default | your computer; a Compute Engine machine | Google's own: `GOOGLE_APPLICATION_CREDENTIALS`, the gcloud login, the machine's |
| `AuthFrom.ENV`               | a server or a CI job                    | `RIG_GCP_KEY`: the key's JSON                                                   |
| `AuthFrom.KEYS`              | an app with its own secrets store       | `{ key }`, the JSON, passed in                                                  |

```ts
import { AuthFrom, createGcp } from "@diphyx/rig-gcp";

createGcp(); // AUTO
createGcp({ auth: { from: AuthFrom.ENV } });
createGcp({ auth: { from: AuthFrom.KEYS, keys: { key: json } } });
```

**On your computer, `AUTO`.** Sign gcloud in for apps, as an account with the roles above:

```bash
gcloud auth application-default login
gcloud config set project my-project
gcloud auth application-default print-access-token # a token here: createGcp() signs in the same way
```

**On a Compute Engine machine, `AUTO`.** Run the machine as a service account with the roles above, and the `cloud-platform` scope:

```bash
gcloud compute instances create my-app --service-account rig@my-project.iam.gserviceaccount.com --scopes cloud-platform
```

**A key of its own, `ENV` or `KEYS`.** A service account with the roles above, and its JSON key. The key's `project_id` is the project the provider uses:

```bash
gcloud iam service-accounts create rig --project my-project
gcloud iam service-accounts keys create rig.json --iam-account rig@my-project.iam.gserviceaccount.com

export RIG_GCP_KEY="$(cat rig.json)"
```

In an env file, the JSON goes on one line, in single quotes: `RIG_GCP_KEY='{"type":"service_account",...}'`. `jq -c . rig.json` prints it so.

**Env names** follow the provider's `name`: `RIG_<NAME>_KEY`, upper-cased, `-` as `_`. A provider named `gcp-eu` reads `RIG_GCP_EU_KEY`; `{ from: AuthFrom.ENV, prefix: "MY_GCP" }` reads `MY_GCP_KEY`.

## 4. Its Network

Machines go in the project's `default` network, each with a public IP.

| Needs                  | Why                                                    | Check                                                    |
| ---------------------- | ------------------------------------------------------ | -------------------------------------------------------- |
| the `default` network  | its machines' network, unless `extra.network` is given | `gcloud compute networks describe default`               |
| a subnet in the region | an auto-mode network has one in each region            | `gcloud compute networks subnets list --network default` |

Another network, or one subnet of it:

```ts
const gcp = createGcp({
    extra: { network: "global/networks/main", subnet: "regions/us-central1/subnetworks/apps" },
});
```

A machine's ports are firewall rules at its own network tag: a deny-all for IPv4 and IPv6, then the kind's `ports` above it. Each rule's description names the machine; they go with it.

## 5. Its Region

`region`, else `RIG_GCP_REGION`, else `CLOUDSDK_COMPUTE_REGION`, else `GOOGLE_CLOUD_REGION`, else `us-central1`. The provider offers the region's zones that sell each type.

## 6. Limits

Quotas are per region: CPUs per family, and _Preemptible CPUs_ for spot. A create over one is `busy account`, and the core tries the next place. See them under IAM & Admin, Quotas, with `gcloud compute regions describe us-central1`.

## 7. A First Check

```ts
import { createRig } from "@diphyx/rig";
import { createGcp } from "@diphyx/rig-gcp";

const gcp = createGcp();
const kinds = [gcp.presets.small({ name: "small" })];
const rig = createRig({ rig: 1, app: "try-gcp", providers: [gcp], kinds });

await rig.open(); // a refusal here: the key, the project, or the region
console.log(await rig.place.list("small"));
await rig.close();
```

## 8. When It Goes Wrong

| You see                                     | It is                                               | Do                                                               |
| ------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------- |
| a refusal at `open`, `missing key`          | `AuthFrom.ENV` with `RIG_GCP_KEY` unset             | set it to the key's JSON                                         |
| a refusal naming the key, its text kept out | `RIG_GCP_KEY` holds part of the JSON, or other text | the whole file, on one line                                      |
| `accessNotConfigured`                       | the Compute Engine API is off                       | `gcloud services enable compute.googleapis.com`                  |
| `forbidden` at a create                     | a role of section 2 is missing                      | the firewall rules need `compute.securityAdmin`                  |
| `busy account`, `quotaExceeded`             | a CPU quota of the region                           | ask for more, or another region                                  |
| no SSH to a running machine                 | its `ports` let in an IP other than yours           | `from`: the IP your SSH leaves from; an HTTP proxy shows its own |

## 9. Its Machines

Every machine is labelled `rig: 1`, `rig-app`, `rig-kind` and `rig-name`, named `<app>-<kind>-<id>`, and its id is `<zone>/<name>`:

```bash
gcloud compute instances list --filter "labels.rig-app=my-app"
```

What the provider does on Compute Engine, call by call, its busy codes, distro images and types: its [README](https://github.com/diphyx/rig/tree/HEAD/packages/gcp).
