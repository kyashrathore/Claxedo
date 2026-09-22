import { describe, expect, test } from "bun:test"
import { isCreationIdentity, readCreationIdentity, type CreationIdentity } from "./identity"

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
