/// <reference types="bun" />
import { expect, test } from "bun:test"
import { machineId, placementId, projectId, type Machine, type Placement } from "@/server"
import { folderPlacesOf } from "./folder-places"

function machine(name: string, overrides: Partial<Machine> = {}): Machine {
  return {
    id: machineId(`enr_${name}`),
    name,
    online: true,
    isThisMachine: false,
    enrolled: true,
    enrollment: { hostId: `host_${name}`, enrollmentId: `enr_${name}`, lastSeenAt: 1, servingWorkspaceIds: [`ws_${name}`] },
    ...overrides,
  }
}

test("this computer comes first, then each of the person's machines that is online, unpaused and serves a folder", () => {
  const machines = [
    machine("build-box"),
    machine("asleep", { online: false }),
    machine("paused", { paused: true }),
    machine("empty", { enrollment: { hostId: "host_empty", enrollmentId: "enr_empty", lastSeenAt: 1, servingWorkspaceIds: [] } }),
    machine("laptop", { isThisMachine: true }),
    machine("unenrolled", { enrolled: false }),
  ]
  expect(folderPlacesOf({ name: "laptop" }, machines, [])).toEqual([{ name: "laptop" }, { machine: machineId("enr_build-box"), name: "build-box" }])
  expect(folderPlacesOf(undefined, machines, []), "a browser is no machine").toEqual([{ machine: machineId("enr_build-box"), name: "build-box" }])
  expect(folderPlacesOf(undefined, [], [])).toEqual([])
})

test("a clone onto a machine defaults beside the first folder it shares", () => {
  const shared = (id: string, path: string): Placement => ({ id: placementId(id), projectId: projectId("prj_a"), kind: "folder", label: "a", path, onThisMachine: false, reachable: true })
  const box = machine("build-box", { enrollment: { hostId: "host_box", enrollmentId: "enr_build-box", lastSeenAt: 1, servingWorkspaceIds: ["ws_second", "ws_first"] } })
  expect(folderPlacesOf(undefined, [box], [shared("ws_first", "/home/ada/first"), shared("ws_second", "/home/ada/code/app")]))
    .toEqual([{ machine: machineId("enr_build-box"), name: "build-box", cloneParent: "/home/ada/code" }])
  expect(folderPlacesOf(undefined, [box], []), "a machine whose folders the catalog has not listed yet has no default").toEqual([{ machine: machineId("enr_build-box"), name: "build-box" }])
})
