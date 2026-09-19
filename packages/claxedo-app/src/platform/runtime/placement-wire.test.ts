import { describe, expect, test } from "bun:test"
import {
  asHostKind,
  backingHostKind,
  controlPlaneListScope,
  controlPlaneRowPlacement,
  inventoryHostKind,
  inventoryKindWord,
  isRelayHostKind,
  placementWire,
  rowHostKind,
  type SelfHost,
} from "./placement-wire"

const enrolled: SelfHost = { kind: "enrolled", enrollmentId: "enr_mine" }
const unenrolled: SelfHost = { kind: "unenrolled" }
const web: SelfHost = { kind: "none" }

describe("placementWire", () => {
  test("an enrolled machine reads its own placement over loopback", () => {
    expect(placementWire({ host: { kind: "machine", enrollmentId: "enr_mine" } }, enrolled)).toBe("loopback")
  })

  test("an enrolled machine reads another machine's placement over the relay", () => {
    expect(placementWire({ host: { kind: "machine", enrollmentId: "enr_other" } }, enrolled)).toBe("relay")
  })

  test("an unenrolled daemon serves its own directories and relays every other machine's", () => {
    expect(placementWire({ host: { kind: "self" }, directory: "/repo/main" }, unenrolled)).toBe("loopback")
    expect(placementWire({ host: { kind: "machine", enrollmentId: "enr_mine" } }, unenrolled)).toBe("relay")
  })

  test("a browser is no machine, so every placement is a relay", () => {
    expect(placementWire({ host: { kind: "machine", enrollmentId: "enr_mine" } }, web)).toBe("relay")
    expect(placementWire({ host: { kind: "provisioner" } }, web)).toBe("relay")
  })

  test("the provisioner's machine is never this one", () => {
    expect(placementWire({ host: { kind: "provisioner" } }, enrolled)).toBe("relay")
  })

  test("a placement naming no machine is unreachable, on every self", () => {
    for (const self of [enrolled, unenrolled, web]) {
      expect(placementWire({ host: { kind: "machine" } }, self)).toBe("unreachable")
    }
  })
})

describe("the control plane's vocabulary", () => {
  test("a row's backing names the host that runs it", () => {
    expect(backingHostKind("cloud-vm")).toBe("provisioner")
    expect(backingHostKind("local-worktree")).toBe("machine")
    expect(backingHostKind("something-else")).toBeUndefined()
    expect(backingHostKind(undefined)).toBeUndefined()
  })

  test("an inventory row's kind word narrows to a host, and back", () => {
    expect(inventoryHostKind("local")).toBe("self")
    expect(inventoryHostKind("cloud")).toBe("provisioner")
    expect(inventoryHostKind("user-hosted")).toBe("machine")
    expect(inventoryHostKind("machine")).toBeUndefined()
    for (const kind of ["self", "provisioner", "machine"] as const) {
      expect(inventoryHostKind(inventoryKindWord(kind))).toBe(kind)
    }
  })

  test("an app-internal host kind narrows without touching the wire words", () => {
    expect(asHostKind("machine")).toBe("machine")
    expect(asHostKind("user-hosted")).toBeUndefined()
    expect(asHostKind(undefined)).toBeUndefined()
  })

  test("the list scope keeps the route vocabulary the control plane answers on", () => {
    expect(controlPlaneListScope("provisioner")).toBe("cloud")
    expect(controlPlaneListScope("machine")).toBe("user-hosted")
  })

  test("a row states its host through either field", () => {
    expect(rowHostKind({ kind: "cloud" })).toBe("provisioner")
    expect(rowHostKind({ backing: "local-worktree" })).toBe("machine")
    expect(rowHostKind({ kind: "local", backing: "cloud-vm" })).toBe("self")
    expect(rowHostKind({})).toBeUndefined()
  })

  test("only a relay host is one this client cannot serve itself", () => {
    expect(isRelayHostKind("machine")).toBe(true)
    expect(isRelayHostKind("provisioner")).toBe(true)
    expect(isRelayHostKind("self")).toBe(false)
    expect(isRelayHostKind(undefined)).toBe(false)
  })
})

describe("controlPlaneRowPlacement", () => {
  test("a machine-placed row carries the host that serves it and the path on it", () => {
    expect(controlPlaneRowPlacement({
      backing: "local-worktree",
      placement: { host_enrollment_id: "enr_a", directory: "/Users/owner/repo" },
    })).toEqual({ host: { kind: "machine", enrollmentId: "enr_a" }, directory: "/Users/owner/repo" })
  })

  test("a machine-placed row no host holds keeps its placement and names no machine", () => {
    expect(controlPlaneRowPlacement({ backing: "local-worktree", placement: {} }))
      .toEqual({ host: { kind: "machine" } })
  })

  test("a cloud row is the provisioner's, whatever its placement says about hosts", () => {
    expect(controlPlaneRowPlacement({
      backing: "cloud-vm",
      placement: { host_enrollment_id: "enr_a", directory: "/workspace" },
    })).toEqual({ host: { kind: "provisioner" }, directory: "/workspace" })
  })

  test("a row this build cannot read states no placement at all", () => {
    expect(controlPlaneRowPlacement({ backing: "future-backing" })).toBeUndefined()
    expect(controlPlaneRowPlacement(undefined)).toBeUndefined()
  })

  test("the host's own path falls back to the row's remote directory", () => {
    expect(controlPlaneRowPlacement({ backing: "cloud-vm", remote_directory: "/workspace" })?.directory)
      .toBe("/workspace")
  })
})
