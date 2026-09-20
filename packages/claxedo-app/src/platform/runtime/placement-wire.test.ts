import { describe, expect, test } from "bun:test"
import {
  asHostKind,
  backingHostKind,
  controlPlaneRowPlacement,
  inventoryHostKind,
  inventoryKindWord,
  isRelayHostKind,
  isSelfHostKind,
  modelStoreWorkspaceKey,
  placementProvisioner,
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

  test("a whole row narrows from either producer's spelling of the placement", () => {
    expect(rowHostKind({ kind: "local", directory: "/repo" })).toBe("self")
    expect(rowHostKind({ backing: "local-worktree" })).toBe("machine")
    // The signed resolve body states the placement as an object and no kind.
    expect(rowHostKind({ workspaceId: "ws_1", backing: { kind: "local-worktree", branch: "main" } })).toBe("machine")
    expect(rowHostKind({ workspaceId: "ws_1", backing: { kind: "cloud-vm", repoName: "app" } })).toBe("provisioner")
    expect(rowHostKind({ backing: { kind: "quantum-vm" } })).toBeUndefined()
    expect(rowHostKind({})).toBeUndefined()
  })

  test("the attached server's own word outranks a control-plane backing on one row", () => {
    expect(rowHostKind({ kind: "local", backing: "local-worktree" })).toBe("self")
    expect(rowHostKind({ kind: "local", backing: { kind: "local-worktree" } })).toBe("self")
  })

  test("only a relay host is one this client cannot serve itself", () => {
    expect(isRelayHostKind("machine")).toBe(true)
    expect(isRelayHostKind("provisioner")).toBe(true)
    expect(isRelayHostKind("self")).toBe(false)
    expect(isRelayHostKind(undefined)).toBe(false)
  })
})

describe("placementProvisioner", () => {
  test("a provisioner placement names its own provisioner, catalogued or not", () => {
    expect(placementProvisioner({ backing: "cloud-vm", driver: "cloudflare" })).toBe("cloudflare")
    expect(placementProvisioner({ kind: "cloud", backing: { kind: "cloud-vm", driver: "fly" } })).toBe("fly")
    // A hosted deployment provisions through a bridge with no catalog entry;
    // naming it is still the placement's own answer.
    expect(placementProvisioner({ backing: "cloud-vm", driver: "fetch" })).toBe("fetch")
    expect(placementProvisioner({ backing: "cloud-vm", driver: "an-operator-run-service" })).toBe("an-operator-run-service")
  })

  test("a provisioner placement that names none has none, rather than a guessed default", () => {
    expect(placementProvisioner({ backing: "cloud-vm" })).toBeUndefined()
  })

  test("a row's own kind outranks a backing it also carries", () => {
    expect(placementProvisioner({ kind: "local", backing: "cloud-vm", driver: "fly" })).toBeUndefined()
  })

  test("a workspace on a machine is not provisioned, so its backing is never a driver", () => {
    expect(placementProvisioner({ backing: "local-worktree" })).toBeUndefined()
    expect(placementProvisioner({ kind: "user-hosted", driver: "cloudflare" })).toBeUndefined()
    expect(placementProvisioner({ kind: "local" })).toBeUndefined()
    expect(placementProvisioner(undefined)).toBeUndefined()
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

describe("modelStoreWorkspaceKey", () => {
  const DIRECTORY = "/repo/main"

  test("a workspace the attached server holds is keyed by its directory even when it has an id", () => {
    expect(modelStoreWorkspaceKey({ host: "self", workspaceId: "ws_1", hostDirectory: DIRECTORY })).toBe(DIRECTORY)
  })

  test("a workspace a machine or the provisioner holds is keyed by its id", () => {
    expect(modelStoreWorkspaceKey({ host: "machine", workspaceId: "ws_1", hostDirectory: DIRECTORY })).toBe("ws_1")
    expect(modelStoreWorkspaceKey({ host: "provisioner", workspaceId: "ws_1", hostDirectory: DIRECTORY })).toBe("ws_1")
  })

  test("a placement with no host, or no id to key by, falls to the directory", () => {
    expect(modelStoreWorkspaceKey({ host: undefined, workspaceId: "ws_1", hostDirectory: DIRECTORY })).toBe(DIRECTORY)
    expect(modelStoreWorkspaceKey({ host: null, workspaceId: "ws_1", hostDirectory: DIRECTORY })).toBe(DIRECTORY)
    expect(modelStoreWorkspaceKey({ host: "machine", hostDirectory: DIRECTORY })).toBe(DIRECTORY)
  })

  // The pane reads a host kind off its sdk workspace; Settings narrows the
  // catalog row's wire word. One workspace has to answer one key or the two
  // surfaces edit two model documents.
  test("the pane's host kind and the catalog's wire word reach the same key", () => {
    const pane = modelStoreWorkspaceKey({ host: "machine", workspaceId: "ws_1", hostDirectory: DIRECTORY })
    const settings = modelStoreWorkspaceKey({ host: inventoryHostKind("user-hosted"), workspaceId: "ws_1", hostDirectory: DIRECTORY })
    expect(pane).toBe(settings)
  })
})

describe("isSelfHostKind", () => {
  test("only the attached server's own placement answers true", () => {
    expect(isSelfHostKind("self")).toBe(true)
    expect(isSelfHostKind("machine")).toBe(false)
    expect(isSelfHostKind("provisioner")).toBe(false)
  })

  // A row whose placement nothing narrowed is not this server's by default;
  // treating it as such opens a local runtime for a workspace nothing placed.
  test("a placement that names no host is not this server's", () => {
    expect(isSelfHostKind(undefined)).toBe(false)
    expect(isSelfHostKind(null)).toBe(false)
    expect(isRelayHostKind(undefined)).toBe(false)
  })
})
