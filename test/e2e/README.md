# E2E tests

Real machines on real clouds, made by the local packages: each run builds the workspace first, and imports `@diphyx/rig`, `@diphyx/rig-aws`, `@diphyx/rig-gcp` and `@diphyx/rig-azure` from it, not from npm. The stages run on a host: one small AWS machine made by rig, whose SSH reaches every machine they make.

```bash
cp test/e2e/.env.sample test/e2e/.env   # then fill it in
pnpm test:e2e                           # start to end: the host up, the files pushed, all run, the host ended
pnpm test:e2e machine failover          # the same, these stages only
```

About 6 minutes for all, on AWS and GCP; the host is ended after, pass or fail.

| Stage      | Makes                                                                                                       | Cost  |
| ---------- | ----------------------------------------------------------------------------------------------------------- | ----- |
| `check`    | nothing: sign-in, `check`, places of each preset, spot ones with their risk                                 | free  |
| `machine`  | one small demand machine: first boot, SSH, script, ports, stop, start, end; a disk grow and a reboot, asked | cents |
| `failover` | a type no zone sells, then a spot machine, which refuses to stop; then the first cloud → the second         | cents |
| `recover`  | a machine ended behind the core's back, recovered; the store lost, the machine adopted                      | cents |
| `sweep`    | ends every machine tagged `rig-app: rig-e2e`                                                                | —     |

`all` is `check`, then `machine`, `failover` and `recover`. `check` and `sweep` run first, each alone; the stages that make machines then run at once, on every cloud at once, each on a store and a kind of its own, each line named by its stage. Each stage ends what it made. A run ends with each stage's result and time. A call whose end takes long, a disk grow, a reboot, holds once the cloud takes it with no error; the stage goes on 5 seconds later.

## Steps

`pnpm test:e2e` is these, in order; each one alone:

```bash
pnpm test:e2e up                 # the host made, or the one held; booted with Node 24 and pnpm
pnpm test:e2e push               # the repo's files and test/e2e/.env to it; its packages installed
pnpm test:e2e run all            # pnpm test:e2e:run all, on it
pnpm test:e2e run sweep          # after a failed stage: every rig-e2e machine ended
pnpm test:e2e down               # the host ended
```

The host: named `rig-e2e-host-<id>`, app `rig`, so `sweep` leaves it; port 22 open, the key only; a life of 6 hours. `pnpm test:e2e:run <stage>...` runs the stages where it is called, the host's own way.

## Layout

| Path            | Is                                                                      |
| --------------- | ----------------------------------------------------------------------- |
| `run.ts`        | the runner: `pnpm test:e2e:run <stage>...`, on the host                 |
| `host.ts`       | the host: `pnpm test:e2e`, start to end, or one step; its store `.host` |
| `stages/`       | one file per stage, each with its `run`                                 |
| `lib/clouds.ts` | the clouds: their providers, the types each stage uses, a kind's tags   |
| `lib/stage.ts`  | a core on a store of its own, its machines ended after; calls at once   |
| `lib/ssh.ts`    | this machine's IP, the SSH key, a command over SSH, the first boot      |
| `lib/log.ts`    | the log, each line named by its stage; the checks, and `done`           |

## Sign-in

`test/e2e/.env` (gitignored), loaded by each run, pushed to the host: copy [`.env.sample`](.env.sample) to it. The names the providers read:

| Var                      | Read by                    | Is                                                                  |
| ------------------------ | -------------------------- | ------------------------------------------------------------------- |
| `RIG_AWS_ID`             | `AuthFrom.ENV` (spec §8.1) | an access key's id                                                  |
| `RIG_AWS_SECRET`         | `AuthFrom.ENV`             | its secret                                                          |
| `RIG_AWS_TOKEN`          | `AuthFrom.ENV`             | a session's token, for a session's keys                             |
| `RIG_AWS_REGION`         | the region (spec §8.2)     | the region; the default VPC's subnets used                          |
| `RIG_GCP_KEY`            | `AuthFrom.ENV`             | a service-account key's JSON; its `project_id` the project          |
| `RIG_GCP_REGION`         | the region                 | the region; the `default` network used                              |
| `RIG_AZURE_TENANT`       | `AuthFrom.ENV`             | a service principal's tenant                                        |
| `RIG_AZURE_ID`           | `AuthFrom.ENV`             | its client id                                                       |
| `RIG_AZURE_SECRET`       | `AuthFrom.ENV`             | its secret                                                          |
| `RIG_AZURE_REGION`       | the region                 | the region; machines in the resource group `rig`, made on first use |
| `RIG_AZURE_SUBSCRIPTION` | the subscription           | the subscription                                                    |

Unset keys: each SDK's own sign-in.

## Env

| Var              | Default   | Is                                |
| ---------------- | --------- | --------------------------------- |
| `RIG_E2E`        | `aws,gcp` | the clouds: `aws`, `gcp`, `azure` |
| `RIG_E2E_APP`    | `rig-e2e` | the app name; tags all            |
| `RIG_E2E_DISTRO` | `ubuntu`  | `ubuntu` or `debian`              |

An SSH key is made once at `test/e2e/.keys/`; port 22 opens to the IP of the machine the run is on only.
