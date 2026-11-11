# Versions

> Each major is a generation: a fresh contract, not an upgrade

A release is `MAJOR.MINOR.PATCH`, like `1.1.0`. The major is the **generation**: rig 1, written `rig: 1` in the config.

| Release                 | For                                                                                                               | Install                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| patch `1.1.0` → `1.1.1` | a fix                                                                                                             | drop-in: same config, same store, same machines |
| minor `1.1` → `1.2`     | an addition: an optional key, a field, a busy code, a preset, a distro or distro version, a guard check, an event | drop-in: same config, same store, same machines |
| major `1` → `2`         | anything that breaks the config, the store, or a plugin                                                           | fresh: a new config, an empty store             |

## A Generation

A generation holds to itself in four places, all set by its major:

| Where    | rig 1                                  | Another generation's                                  |
| -------- | -------------------------------------- | ----------------------------------------------------- |
| config   | `rig: 1`                               | refused at open: `config is for rig 2, this is rig 1` |
| plugins  | each provider and worker says `rig: 1` | refused at open                                       |
| store    | under `<store>/rig/1/`                 | never read: its folder stays as it was                |
| machines | tagged `rig: 1`                        | never touched: not ended, recovered, nor counted      |

Nothing of one generation is moved, converted, or read by the next. A machine of rig 1 keeps running under rig 2, untouched: end it with rig 1, or by hand.

## Generations

| Generation | First release | What it brought   |
| ---------- | ------------- | ----------------- |
| rig 1      | `1.0.0`       | the first release |

## Moving to a New Generation

1. Drain: let job machines end, and end what you no longer need, with the old release.
2. Install the new release of the core and of every plugin; they only work with each other.
3. Write a fresh config, `rig: 2` first, from that generation's docs.
4. Open it: the store starts empty, in `<store>/rig/2/`.
5. Delete `<store>/rig/1/` when you no longer need it.
