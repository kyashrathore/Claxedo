import { expect, test } from "bun:test"
import type { CreationIdentity } from "@claxedo/process-ownership/launch"
import { readPtyCreationIdentity } from "./creation-identity"

const spawnedAt = 10_000
const identity: CreationIdentity = { pid: 4321, processGroupId: 4321, parentPid: 1234, startedAtMs: 9_000, startSecond: "9", bootTime: "1", source: "linux-procfs" }
const inherited = { ...identity, processGroupId: 1234 }

function observations(rows: Array<CreationIdentity | undefined>) {
  let reads = 0
  let clock = 0
  return {
    read: async () => rows[Math.min(reads++, rows.length - 1)],
    now: () => clock,
    wait: async () => { clock += 100 },
    reads: () => reads,
  }
}

test("PTY admission waits for the spawned child to establish its own process group", async () => {
  const io = observations([inherited, inherited, identity])
  expect(await readPtyCreationIdentity(identity.pid, spawnedAt, () => false, io)).toEqual({ observed: identity, identity })
  expect(io.reads()).toBe(3)
})

test("PTY admission never waits for an old process to become ownable", async () => {
  const old = { ...inherited, startedAtMs: 1_000 }
  const io = observations([old, identity])
  expect(await readPtyCreationIdentity(identity.pid, spawnedAt, () => false, io)).toEqual({ observed: old })
  expect(io.reads()).toBe(1)
})

test("PTY admission refuses a PID whose creation identity changes while its group is forming", async () => {
  for (const changed of [{ ...identity, startSecond: "10" }, { ...identity, bootTime: "2" }, { ...identity, pid: 4322 }]) {
    const io = observations([inherited, changed])
    expect(await readPtyCreationIdentity(identity.pid, spawnedAt, () => false, io)).toEqual({ observed: changed })
  }
})

test("PTY admission remains unowned when the native process exits during observation", async () => {
  const io = observations([inherited, identity])
  expect(await readPtyCreationIdentity(identity.pid, spawnedAt, () => io.reads() > 1, io)).toEqual({ observed: identity })
})

test("PTY admission stops waiting when the child never establishes its group", async () => {
  const io = observations([inherited])
  expect(await readPtyCreationIdentity(identity.pid, spawnedAt, () => false, io)).toEqual({ observed: inherited })
  expect(io.now()).toBe(1_000)
})

test("PTY admission preserves a failed identity probe and refuses an absent process", async () => {
  const io = observations([undefined])
  expect(await readPtyCreationIdentity(identity.pid, spawnedAt, () => false, io)).toEqual({ observed: undefined })
  await expect(readPtyCreationIdentity(identity.pid, spawnedAt, () => false, { ...io, read: async () => { throw new Error("probe failed") } })).rejects.toThrow("probe failed")
})
