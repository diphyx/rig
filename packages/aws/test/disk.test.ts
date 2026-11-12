import { describe, expect, it } from "vitest";

import { createAws } from "../src/index.js";
import { fake, fail, reservation } from "./fake.js";

describe("aws: disks", () => {
    const INSTANCE = {
        InstanceId: "i-1",
        RootDeviceName: "/dev/sda1",
        BlockDeviceMappings: [{ DeviceName: "/dev/sda1", Ebs: { VolumeId: "vol-1" } }],
    };

    it("reads a disk with no size change as ready, at its own size", async () => {
        const { client } = fake({
            DescribeInstances: () => {
                return reservation(INSTANCE);
            },
            DescribeVolumes: () => {
                return { Volumes: [{ Size: 30 }] };
            },
            DescribeVolumesModifications: () => {
                return fail("InvalidVolumeModification.NotFound");
            },
        });

        expect(await createAws({ region: "us-east-1", extra: { client } }).disk!.get("i-1")).toEqual({
            gb: 30,
            ready: true,
        });
    });

    it("reads a size change past modifying as ready, at its new size; no size at all as 0", async () => {
        let volumes: unknown = { Volumes: [{ Size: 30 }] };
        let changes: unknown = { VolumesModifications: [{ ModificationState: "optimizing", TargetSize: 60 }] };
        const { client } = fake({
            DescribeInstances: () => {
                return reservation(INSTANCE);
            },
            DescribeVolumes: () => {
                return volumes;
            },
            DescribeVolumesModifications: () => {
                return changes;
            },
        });

        const { disk } = createAws({ region: "us-east-1", extra: { client } });

        expect(await disk!.get("i-1")).toEqual({ gb: 60, ready: true });

        volumes = {};
        changes = {};

        expect(await disk!.get("i-1")).toEqual({ gb: 0, ready: true });
    });

    it("throws an error reading a size change that is not a not found", async () => {
        const { client } = fake({
            DescribeInstances: () => {
                return reservation(INSTANCE);
            },
            DescribeVolumes: () => {
                return {};
            },
            DescribeVolumesModifications: () => {
                return fail("UnauthorizedOperation");
            },
        });

        await expect(createAws({ region: "us-east-1", extra: { client } }).disk!.get("i-1")).rejects.toThrow(
            "UnauthorizedOperation",
        );
    });

    it("refuses to grow a machine with no root volume, or one EC2 does not know", async () => {
        let answer: unknown = reservation({ ...INSTANCE, RootDeviceName: "/dev/xvda" });
        const { client } = fake({
            DescribeInstances: () => {
                return answer;
            },
        });

        const { disk } = createAws({ region: "us-east-1", extra: { client } });

        await expect(disk!.grow("i-1", 60)).rejects.toThrow("aws: i-1 has no root volume");

        answer = reservation({ InstanceId: "i-1", RootDeviceName: "/dev/sda1", BlockDeviceMappings: [{}] });

        await expect(disk!.grow("i-1", 60)).rejects.toThrow("aws: i-1 has no root volume");

        answer = {};

        await expect(disk!.grow("i-1", 60)).rejects.toThrow("aws: i-1 has no root volume");
    });
});
