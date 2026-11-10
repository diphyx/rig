import type { Instance, Tag } from "@aws-sdk/client-ec2";
import { Market, type ProviderMachine, Status, type Tags } from "@diphyx/rig";

import { fromAws } from "./data.js";

/** §11: EC2's instance states onto rig's statuses; terminated, as after a take-back, is `ended`. */
const STATUS: Record<string, Status> = {
    pending: Status.PENDING,
    running: Status.RUNNING,
    stopping: Status.STOPPING,
    stopped: Status.STOPPED,
    "shutting-down": Status.ENDING,
    terminated: Status.ENDED,
};

/** Every state but terminated, for `list`. */
export const LIVE = ["pending", "running", "stopping", "stopped", "shutting-down"];

export function tagsOf(tags: Tag[] | undefined): Tags {
    return Object.fromEntries(
        (tags ?? []).map((tag) => {
            return [tag.Key ?? "", tag.Value ?? ""];
        }),
    );
}

/** An instance as rig sees it. */
export function toMachine(instance: Instance): ProviderMachine {
    const ip = {
        ...(instance.PublicIpAddress && { public: instance.PublicIpAddress }),
        ...(instance.PrivateIpAddress && { private: instance.PrivateIpAddress }),
    };

    return {
        id: instance.InstanceId!,
        status: STATUS[instance.State?.Name ?? ""] ?? Status.PENDING,
        market: instance.InstanceLifecycle === "spot" ? Market.SPOT : Market.DEMAND,
        type: instance.InstanceType ?? "",
        zone: instance.Placement?.AvailabilityZone ?? "",
        tags: fromAws(tagsOf(instance.Tags)),
        ...(Object.keys(ip).length > 0 && { ip }),
        created: instance.LaunchTime?.getTime() ?? 0,
    };
}
