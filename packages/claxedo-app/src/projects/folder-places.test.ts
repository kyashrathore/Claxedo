/// <reference types="bun" />
import { expect, test } from "bun:test"
import { machineId, type Machine } from "@/server"
import { folderPlacesOf } from "./folder-places"

function machine(name: string, overrides: Partial<Machine> = {}): Machine {
  return {
    id: machineId(`enr_${name}`),
    name,
    online: true,
    isThisMachine: false,
    enrolled: true,
    enrollment: { hostId: `host_${name}`, lastSeenAt: 1, servingWorkspaceIds: [`ws_${name}`] },
    ...overrides,
  }
}

test("this computer comes first, then each of the person's machines that is online, unpaused and serves a folder", () => {
  const machines = [
    machine("build-box"),
    machine("asleep", { online: false }),
    machine("paused", { paused: true }),
    machine("empty", { enrollment: { hostId: "host_empty", lastSeenAt: 1, servingWorkspaceIds: [] } }),
    machine("laptop", { isThisMachine: true }),
    machine("unenrolled", { enrolled: false }),
  ]
  expect(folderPlacesOf({ name: "laptop" }, machines)).toEqual([{ name: "laptop" }, { machine: machineId("enr_build-box"), name: "build-box" }])
  expect(folderPlacesOf(undefined, machines), "a browser is no machine").toEqual([{ machine: machineId("enr_build-box"), name: "build-box" }])
  expect(folderPlacesOf(undefined, [])).toEqual([])
})
