import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import {
  claxedoDaemonOwnershipPath,
  clearDaemonOwnershipSnapshot,
  createDaemonOwnershipPublisher,
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
    changedAt: 1_000,
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
    // NT keeps no mode bits: there the snapshot takes its directory's
    // descriptor, which is why it is written with nothing a secret could be in.
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  test("carries ids, states and times, and nothing a command line would be in", () => {
    const file = claxedoDaemonOwnershipPath(root())
    const publisher = createDaemonOwnershipPublisher({
      file,
      pid: 42,
      inspect: () => inspection({ owners: [owner("terminal:t1", "running")] }),
      now: () => 5_000,
    })
    publisher.start()

    const written = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
    expect(Object.keys(written).sort()).toEqual([
      "changedAt", "generation", "machineId", "owners", "pid", "residencyPins", "revision",
    ])
    const [row] = written.owners as Array<Record<string, unknown>>
    expect(Object.keys(row).sort()).toEqual(["generation", "id", "kind", "pins", "state"])
  })

  test("writes when publishing starts and on each change it is told of, and nothing before it starts or after it stops", () => {
    const file = claxedoDaemonOwnershipPath(root())
    let at = 1_000
    let owners = [owner("workspace:ws_a")]
    const publisher = createDaemonOwnershipPublisher({
      file,
      pid: 42,
      inspect: () => inspection({ owners }),
      now: () => at,
    })

    publisher.publish()
    expect(readDaemonOwnershipSnapshot(file), "before start").toBeUndefined()

    publisher.start()
    expect(readDaemonOwnershipSnapshot(file)?.changedAt).toBe(1_000)

    at = 60_000
    owners = [...owners, owner("terminal:t1", "running")]
    publisher.publish()
    expect(readDaemonOwnershipSnapshot(file)?.changedAt).toBe(60_000)
    expect(readDaemonOwnershipSnapshot(file)?.owners).toHaveLength(2)

    publisher.stop()
    at = 90_000
    publisher.publish()
    expect(readDaemonOwnershipSnapshot(file)?.changedAt, "after stop").toBe(60_000)
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

    publisher.start()

    expect(failures).toHaveLength(1)
  })
})
