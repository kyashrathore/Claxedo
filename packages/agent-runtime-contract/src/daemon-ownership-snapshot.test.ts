import {
  daemonOwnershipSnapshotPath,
  DAEMON_OWNERSHIP_SNAPSHOT_FILE,
  isDaemonOwnershipSnapshot,
} from "./daemon-ownership-snapshot"
import { describe, test, expect } from "bun:test"

describe("the ownership snapshot two products share", () => {
  const snapshot = {
    machineId: "local",
    generation: "generation-1",
    pid: 42,
    revision: "rev-1",
    changedAt: 1_000,
    residencyPins: 1,
    owners: [{ id: "workspace:ws_a", kind: "workspace_runtime", generation: "mount-1", state: "serving", pins: false }],
  }

  test("its path is one join, so the writer and the reader name one file", () => {
    expect(daemonOwnershipSnapshotPath("/data")).toBe("/data/local-daemon-ownership.json")
    expect(daemonOwnershipSnapshotPath("/data/")).toBe("/data/local-daemon-ownership.json")
    expect(daemonOwnershipSnapshotPath("/data")).toContain(DAEMON_OWNERSHIP_SNAPSHOT_FILE)
  })

  test("a reader accepts what a writer writes and refuses what it does not", () => {
    expect(isDaemonOwnershipSnapshot(snapshot)).toBe(true)
    // Each field a reader relies on, absent or wrong.
    expect(isDaemonOwnershipSnapshot({ ...snapshot, machineId: "" })).toBe(false)
    expect(isDaemonOwnershipSnapshot({ ...snapshot, pid: 0 })).toBe(false)
    expect(isDaemonOwnershipSnapshot({ ...snapshot, changedAt: "soon" })).toBe(false)
    expect(isDaemonOwnershipSnapshot({ ...snapshot, residencyPins: undefined })).toBe(false)
    expect(isDaemonOwnershipSnapshot({ ...snapshot, owners: [{ id: "x" }] })).toBe(false)
    expect(isDaemonOwnershipSnapshot({ ...snapshot, owners: "none" })).toBe(false)
    expect(isDaemonOwnershipSnapshot(undefined)).toBe(false)
  })
})
