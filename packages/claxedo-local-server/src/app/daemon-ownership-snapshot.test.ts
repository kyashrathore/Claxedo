import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import {
  claxedoDaemonOwnershipPath,
  clearDaemonOwnershipSnapshot,
  createDaemonOwnershipPublisher,
  daemonOwnershipSnapshotIsStale,
  readDaemonOwnershipSnapshot,
  writeDaemonOwnershipSnapshot,
  type DaemonOwnershipSnapshot,
} from "./daemon-ownership-snapshot"
import type { LocalDaemonOwner, MachineRecoveryInspection } from "./local-daemon-lifecycle"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function root() {
  const dir = mkdtempSync(path.join(tmpdir(), "claxedo-daemon-ownership-"))
  roots.push(dir)
  return dir
}

function owner(id: string, state = "serving"): LocalDaemonOwner {
  return { id, kind: "workspace_runtime", generation: `${state}#0`, state, pins: state !== "serving" }
}

function inspection(overrides: Partial<MachineRecoveryInspection> = {}): MachineRecoveryInspection {
  return {
    machineId: "local",
    generation: "generation-1",
    target: { scope: "machine", machineId: "local", ownerGeneration: "generation-1" },
    scopeRevision: "rev-1",
    owners: [owner("workspace:ws_a")],
    preview: { sessions: [], resources: [], summary: "1 named owners" },
    residencyPins: 1,
    operations: [],
    receipt: "durable",
    ...overrides,
  }
}

function snapshot(overrides: Partial<DaemonOwnershipSnapshot> = {}): DaemonOwnershipSnapshot {
  return {
    machineId: "local",
    generation: "generation-1",
    pid: 42,
    revision: "rev-1",
    writtenAt: 1_000,
    residencyPins: 1,
    owners: [owner("workspace:ws_a")],
    ...overrides,
  }
}

describe("the daemon ownership snapshot", () => {
  test("is written atomically, owner-readable only, and reads back as itself", () => {
    const file = claxedoDaemonOwnershipPath(root())
    writeDaemonOwnershipSnapshot(file, snapshot())

    expect(readDaemonOwnershipSnapshot(file)).toEqual(snapshot())
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  test("carries ids, states and times, and nothing a command line would be in", () => {
    const file = claxedoDaemonOwnershipPath(root())
    const publisher = createDaemonOwnershipPublisher({
      file,
      pid: 42,
      inspect: () => inspection({ owners: [owner("terminal:t1", "running")] }),
      now: () => 5_000,
    })
    publisher.publish(true)

    const written = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
    expect(Object.keys(written).sort()).toEqual([
      "generation", "machineId", "owners", "pid", "residencyPins", "revision", "writtenAt",
    ])
    const [row] = written.owners as Array<Record<string, unknown>>
    expect(Object.keys(row).sort()).toEqual(["generation", "id", "kind", "pins", "state"])
  })

  test("republishes on a transition and no more than once every five seconds otherwise", () => {
    const file = claxedoDaemonOwnershipPath(root())
    let at = 1_000
    let owners = [owner("workspace:ws_a")]
    let revision = "rev-1"
    const publisher = createDaemonOwnershipPublisher({
      file,
      pid: 42,
      inspect: () => inspection({ owners, scopeRevision: revision }),
      now: () => at,
    })

    publisher.publish(true)
    expect(readDaemonOwnershipSnapshot(file)?.writtenAt).toBe(1_000)

    at = 2_000
    publisher.publish()
    expect(readDaemonOwnershipSnapshot(file)?.writtenAt, "inside the interval, unchanged").toBe(1_000)

    owners = [...owners, owner("terminal:t1", "running")]
    revision = "rev-2"
    publisher.publish()
    expect(readDaemonOwnershipSnapshot(file)?.writtenAt, "a transition publishes at once").toBe(2_000)
    expect(readDaemonOwnershipSnapshot(file)?.owners).toHaveLength(2)

    at = 8_000
    publisher.publish()
    expect(readDaemonOwnershipSnapshot(file)?.writtenAt, "the interval elapsed with work active").toBe(8_000)
  })

  test("a snapshot older than ten seconds is stale for presentation", () => {
    expect(daemonOwnershipSnapshotIsStale(snapshot(), 11_001)).toBe(true)
    expect(daemonOwnershipSnapshotIsStale(snapshot(), 11_000)).toBe(false)
  })

  test("only the generation that wrote it can clear it", () => {
    const file = claxedoDaemonOwnershipPath(root())
    writeDaemonOwnershipSnapshot(file, snapshot())

    clearDaemonOwnershipSnapshot(file, { pid: 42, generation: "generation-0" })
    expect(readDaemonOwnershipSnapshot(file)).toBeDefined()

    clearDaemonOwnershipSnapshot(file, { pid: 42, generation: "generation-1" })
    expect(readDaemonOwnershipSnapshot(file)).toBeUndefined()
  })

  test("a file that is not a snapshot is no snapshot, and a missing one is not an empty one", () => {
    const dir = root()
    const file = claxedoDaemonOwnershipPath(dir)
    expect(readDaemonOwnershipSnapshot(file)).toBeUndefined()

    writeFileSync(file, "{not json")
    expect(readDaemonOwnershipSnapshot(file)).toBeUndefined()

    writeFileSync(file, JSON.stringify({ ...snapshot(), owners: [{ id: "x" }] }))
    expect(readDaemonOwnershipSnapshot(file)).toBeUndefined()
  })

  test("a write that fails reaches the caller instead of leaving a silent gap", () => {
    const failures: unknown[] = []
    const publisher = createDaemonOwnershipPublisher({
      file: path.join(root(), "no-such-dir\0bad", "ownership.json"),
      pid: 42,
      inspect: () => inspection(),
      now: () => 1_000,
      onError: (error) => failures.push(error),
    })

    publisher.publish(true)

    expect(failures).toHaveLength(1)
  })
})
