import { describe, expect, spyOn, test } from "bun:test"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { identityFromSpawn, isCreationIdentity, readCreationIdentity, verifyCreationIdentity, type CreationIdentity } from "./identity"

const identity = (over: Record<string, unknown> = {}): unknown => ({
  pid: 4321,
  processGroupId: 4321,
  parentPid: 1,
  startSecond: "Mon Sep 22 09:14:03 2026",
  startedAtMs: 1_790_000_043_000,
  bootTime: "1789000000",
  source: "darwin-ps",
  ...over,
})

describe("a creation identity read back out of a record", () => {
  test("accepts what this platform's own probe produced", async () => {
    const read = await readCreationIdentity(process.pid)
    expect(isCreationIdentity(JSON.parse(JSON.stringify(read)))).toBe(true)
  })

  test("accepts a complete row and keeps its fields", () => {
    const value = identity()
    if (!isCreationIdentity(value)) throw new Error("a complete row must be admitted")
    const verified: CreationIdentity = value
    expect(verified.pid).toBe(4321)
    expect(verified.source).toBe("darwin-ps")
  })

  test("refuses a pid that names a process group rather than a process", () => {
    expect(isCreationIdentity(identity({ pid: 0 }))).toBe(false)
    expect(isCreationIdentity(identity({ pid: -4321 }))).toBe(false)
    expect(isCreationIdentity(identity({ pid: 4321.5 }))).toBe(false)
  })

  test("refuses a source no build of this probe produces", () => {
    expect(isCreationIdentity(identity({ source: "darwin-sysctl" }))).toBe(false)
    expect(isCreationIdentity(identity({ source: "" }))).toBe(false)
  })

  test("refuses a row missing a verification key, and a non-record", () => {
    expect(isCreationIdentity(identity({ startSecond: "" }))).toBe(false)
    expect(isCreationIdentity(identity({ bootTime: undefined }))).toBe(false)
    expect(isCreationIdentity(identity({ startedAtMs: "1790000043000" }))).toBe(false)
    expect(isCreationIdentity(null)).toBe(false)
    expect(isCreationIdentity("darwin-ps")).toBe(false)
  })
})

describe("identityFromSpawn", () => {
  const spawned = (startedAtMs: number, source: CreationIdentity["source"] = "darwin-ps"): CreationIdentity => ({
    pid: 4242,
    processGroupId: 4242,
    startSecond: String(Math.floor(startedAtMs / 1000)),
    bootTime: "1",
    parentPid: 1,
    startedAtMs,
    source,
  })

  test("a process that began after the spawn is the one this launcher started", () => {
    const spawnedAt = 1_000_000
    expect(identityFromSpawn(spawned(spawnedAt + 5), spawnedAt)).toBeDefined()
  })

  test("a pid whose process began before the spawn is a stranger the launcher never started", () => {
    const spawnedAt = 1_000_000
    expect(identityFromSpawn(spawned(spawnedAt - 60_000), spawnedAt)).toBeUndefined()
  })

  test("a darwin start floored to the spawn's second is accepted", () => {
    expect(identityFromSpawn(spawned(1_000_000), 1_000_900)).toBeDefined()
  })

  test("a Linux start that reads a whole second before the spawn's second is accepted", () => {
    // btime and starttime are both floored to the second: 42.076 read as 41.000.
    expect(identityFromSpawn(spawned(1_001_000, "linux-procfs"), 1_002_076)).toBeDefined()
  })
})


/**
 * Makes this platform's probe fail the way it fails on a real machine — `ps`
 * not on PATH on darwin, `/proc/<pid>/stat` refusing to be read on linux (a
 * `hidepid` mount) — and returns the undo. Boot time is already memoised by
 * the read that produced the recorded identity, so only the pid probe breaks.
 */
async function breakCreationProbe(): Promise<() => Promise<void>> {
  if (process.platform === "linux") {
    const readFile = spyOn(fs, "readFile")
      .mockRejectedValue(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }))
    return async () => { readFile.mockRestore() }
  }
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), "no-ps-"))
  const realPath = process.env.PATH
  process.env.PATH = empty
  return async () => {
    process.env.PATH = realPath
    await fs.rm(empty, { recursive: true, force: true })
  }
}

describe("verifying a recorded identity", () => {
  test.skipIf(process.platform === "win32")("a probe that cannot run is an unknown verdict, never an exit", async () => {
    const recorded = await readCreationIdentity(process.pid)
    if (!recorded) throw new Error("the running process must be readable")

    const restore = await breakCreationProbe()
    let verdict
    try {
      verdict = await verifyCreationIdentity(recorded)
    } finally {
      await restore()
    }
    expect(verdict.state).toBe("unknown")
    expect(verdict.state === "unknown" && verdict.reason).toContain(String(process.pid))
    expect((await verifyCreationIdentity(recorded)).state).toBe("live")
  })
})
