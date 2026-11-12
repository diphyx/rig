# GCP

> Set up a Google Cloud project for `@diphyx/rig-gcp`: its key, its roles, its network, and a first check

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

## 2. Its Keys

The provider signs in the way Google's libraries do by default: `GOOGLE_APPLICATION_CREDENTIALS`, the `gcloud auth application-default login`, or the machine's own service account. Where `gcloud auth application-default print-access-token` works, `createGcp()` works.

For a key of its own, a service account's JSON key:

```bash
gcloud iam service-accounts create rig --project my-project
gcloud iam service-accounts keys create rig.json --iam-account rig@my-project.iam.gserviceaccount.com

export RIG_GCP_KEY="$(cat rig.json)"
```

```ts
import { AuthFrom, createGcp } from "@diphyx/rig-gcp";

const gcp = createGcp({ auth: { from: AuthFrom.ENV } });
```

| Way             | Its key                                                           |
| --------------- | ----------------------------------------------------------------- |
| `AuthFrom.AUTO` | Google's own: the credentials file, the gcloud login, the machine |
| `AuthFrom.ENV`  | `RIG_GCP_KEY`: the key's JSON, on one line                        |
| `AuthFrom.KEYS` | `{ key }`, the JSON, passed in                                    |

In an env file, the JSON goes on one line, in single quotes: `RIG_GCP_KEY='{"type":"service_account",...}'`.

## 3. What They May Do

| Role                             | For                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------- |
| `roles/compute.instanceAdmin.v1` | machines and their disks: create, get, list, start, stop, reset, delete, resize |
| `roles/compute.securityAdmin`    | each machine's firewall rules: create, list, delete                             |
| `roles/iam.serviceAccountUser`   | only when a kind's machines run as a service account: `identity`                |

```bash
for role in roles/compute.instanceAdmin.v1 roles/compute.securityAdmin; do
    gcloud projects add-iam-policy-binding my-project \
        --member serviceAccount:rig@my-project.iam.gserviceaccount.com --role "$role"
done
```

Distro images come from Google's public image projects, `ubuntu-os-cloud` and `debian-cloud`, which every project may read.

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
| `forbidden` at a create                     | a role of section 3 is missing                      | the firewall rules need `compute.securityAdmin`                  |
| `busy account`, `quotaExceeded`             | a CPU quota of the region                           | ask for more, or another region                                  |
| no SSH to a running machine                 | its `ports` let in an IP other than yours           | `from`: the IP your SSH leaves from; an HTTP proxy shows its own |

## 9. Its Machines

Every machine is labelled `rig: 1`, `rig-app`, `rig-kind` and `rig-name`, named `<app>-<kind>-<id>`, and its id is `<zone>/<name>`:

```bash
gcloud compute instances list --filter "labels.rig-app=my-app"
```

What the provider does on Compute Engine, call by call, its busy codes, distro images and types: its [README](https://github.com/diphyx/rig/tree/HEAD/packages/gcp).
