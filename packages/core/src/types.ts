import type { Arch, Busy, Event, Why, Finding, Guard, Market, Distro, Protocol, Slot, Status } from "./enums.js";

export type Tags = Record<string, string>;

/** §22.2: what makes a kind's machines work for a worker: which worker, its tags, and the worker's own keys. */
export type KindWorker = {
    /** The worker's `name`; the only one, when the config has one. */
    name?: string;
    /** The kinds of work its machines do: a job runs only on a machine with its tag. */
    tags: string[];
    /** The worker's own keys, as it defines them: grid's `cmds`, `signal`. */
    [key: string]: unknown;
};

/** §22.1: a worker: a plugin that runs jobs on the machines of kinds with a `worker`. */
export type Worker = {
    slot: Slot.WORKER;
    name: string;
    rig: number;
    /** Optional: what it finds out first, like its own address; called once, when the core opens, before any `setup`. */
    open?(): Promise<void>;
    /** Throws when a kind's `worker` is not one: its own keys, as the worker defines them. */
    check(worker: KindWorker): void;
    /** For one machine, at its create: its first-boot lines, the inbound rules it needs, and what the worker knows it by. */
    setup(machine: { name: string; tags: string[]; worker: KindWorker }): {
        script: string[];
        ports: Rule[];
        key: string;
    };
    /** Takes a machine, by its name, its IPs, its key and its tags. */
    add(machine: {
        name: string;
        ip: { public?: string; private?: string };
        key: string;
        tags: string[];
    }): Promise<void>;
    /** Forgets a machine, by its name. */
    drop(name: string): Promise<void>;
    /** No more machines come for these tags: a job waiting for them may fail. */
    spent(tags: string[]): Promise<void>;
};

/** §6.2: who can sign in over SSH: the keys, for the user; by default the distro's. */
export type Login = { user?: string; keys: string[] };

/** §6.1: a distro, by its name and major version; without a version, its default. */
export type KindDistro = { name: Distro; version?: string };

/** §10: a distro as a provider gets it: its version always filled in. */
export type SpecDistro = { name: Distro; version: string };

/** One item of a kind's `try` list. */
export type Entry = {
    provider: string;
    market: Market[];
    types: string[];
    /** This provider's image id, booted as it is in place of the kind's `distro`. */
    image?: string;
    extra?: Record<string, unknown>;
};

/** A named recipe for machines. */
export type Kind = {
    name: string;
    try: Entry[];
    /** The distro every machine boots, but on an entry with its own `image`; `ubuntu` at its default version when absent. */
    distro?: KindDistro;
    disk?: number;
    /** Who can sign in over SSH, at first boot. */
    login?: Login;
    /** Every machine works for a worker: §22. */
    worker?: KindWorker;
    /** What every machine runs once, at first boot: a script, or its lines. */
    script?: string | string[];
    risk?: { max: string };
    life?: string;
    recovers?: number;
    /** The app's own tags; no key starts with `rig`. */
    tags?: Tags;
    /** The inbound rules every machine of the kind starts with; all else is closed. */
    ports?: Rule[];
};

/** Where a machine could be created. */
export type Place = {
    market: Market;
    type: string;
    zone: string;
    /** For people. */
    price?: string;
};

/** A type, as risk sees it. */
export type Shape = {
    cpu: number;
    mem: number;
    gpu?: string;
    arch: Arch;
};

/** What to create, filled by the core. */
export type Spec = {
    name: string;
    /** The kind's distro: the provider boots its newest image. Absent when `image` is given. */
    distro?: SpecDistro;
    /** The entry's image, booted as it is. Absent when `distro` is given. */
    image?: string;
    disk?: number;
    script?: string;
    tags: Tags;
    /** The kind's ports: the only inbound rules the machine starts with. */
    ports: Rule[];
    extra?: Record<string, unknown>;
};

/** What one try gave. */
export type Answer = { ok: { id: string } } | { busy: Busy; message?: string };

/** A machine as the provider sees it. */
export type ProviderMachine = {
    id: string;
    status: Status;
    market: Market;
    type: string;
    zone: string;
    /** The image it boots, by the provider's id. */
    image?: string;
    tags: Tags;
    ip?: { public?: string; private?: string };
    created: number;
};

/** One port rule. */
export type Rule = {
    id?: string;
    port: number;
    to?: number;
    protocol?: Protocol;
    from: string;
};

/** §10: the rules `port.close` closes: those with every key it gives. */
export type Match = { port?: number; to?: number; protocol?: Protocol; from?: string };

export type Can = {
    spot?: boolean;
    stop?: boolean;
    disk?: boolean;
    port?: boolean;
};

/** A plugin for one cloud. */
export type Provider = {
    slot: Slot.PROVIDER;
    name: string;
    rig: number;
    can?: Can;
    /** §8: the distro versions it offers: every distro at its default version, at least. */
    distros: Partial<Record<Distro, string[]>>;
    /** Optional: throws when the provider cannot work, checked at open. */
    check?(): Promise<void>;
    /** Optional: a type's shape, from the provider's own data; `null` when unknown. */
    shape?(type: string): Promise<Shape | null>;
    places(entry: Entry): Promise<Place[]>;
    create(place: Place, spec: Spec): Promise<Answer>;
    get(id: string): Promise<ProviderMachine | null>;
    list(tags: Tags): Promise<ProviderMachine[]>;
    end(id: string): Promise<void>;
    reboot(id: string): Promise<void>;
    start?(id: string): Promise<void>;
    stop?(id: string): Promise<void>;
    disk?: {
        grow(id: string, gb: number): Promise<void>;
        get(id: string): Promise<{ gb: number; ready: boolean }>;
    };
    port?: {
        open(id: string, rule: Rule): Promise<Rule>;
        close(id: string, rule: string): Promise<void>;
        list(id: string): Promise<Rule[]>;
    };
};

/** §5: the core's config. */
export type RigConfig = {
    rig: number;
    app: string;
    providers: Provider[];
    kinds: Kind[];
    guard?: Guard;
    every?: string;
    poll?: string;
    store?: string;
    /** §22: the plugins that run jobs on the machines of kinds with a `worker`. */
    workers?: Worker[];
    /** §5: the lib's own settings. */
    extra?: RigExtra;
};

/** A machine as the app sees it. */
export type Machine = ProviderMachine & {
    provider: string;
    kind: string;
    name: string;
    /** The login user, when its kind has a `login`. */
    user?: string;
    /** When its kind has a `worker`: which worker, what it knows the machine by, its tags (fixed at its create), and the IPs the worker has, once it has it. */
    worker?: { name: string; key: string; tags: string[]; ip?: { public?: string; private?: string } };
};

/** The core's own count for one place. */
export type Seen = { tries: number; busy: number; created: number; lost: number; hours: number };

/** The core's estimate for one place, in percent a month. */
export type Risk = { takeback: number; pressure: number; prior: number; seen: Seen };

/** A place as `place.list` gives it. */
export type Listed = Place & { provider: string; risk: Risk };

/** §18: each event's data. */
export type Events = {
    [Event.TRY]: { kind: string; place: Place & { provider: string }; answer: Answer | { error: unknown } };
    [Event.MACHINE_CREATED]: { machine: Machine };
    [Event.MACHINE_ENDED]: { machine: Machine; reason?: Why };
    [Event.MACHINE_LOST]: { machine: Machine };
    [Event.MACHINE_RECOVERED]: { lost: Machine; machine: Machine };
    [Event.MACHINE_FAILED]: { machine: Machine; recovers: number };
    [Event.MACHINE_ORPHAN]: { machine: Machine };
    [Event.GUARD]: { kind: string; code: Finding };
};

/** The TypeScript core's own settings, under `extra`. */
export type RigExtra = {
    /** The clock, in unix ms; the kit sets its own. */
    clock?: () => number;
    /** The wait between polls; the kit moves its clock instead. */
    sleep?: (ms: number) => Promise<void>;
    /** Run rounds every `every`; `false` leaves them to `round()`. */
    rounds?: boolean;
};
