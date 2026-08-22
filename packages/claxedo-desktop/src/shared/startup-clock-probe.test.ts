import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  recordStartupClock,
  startupClockEvent,
  startupClockProbePath,
} from "./startup-clock-probe"

// This module only writes; the benchmark harness reads. So the assertions here
// are about the two things a writer owes its reader — the clock it stamps, and
// the silence it keeps when nobody asked.
function readLog(file: string) {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const parsed: unknown = JSON.parse(line)
      if (!parsed || typeof parsed !== "object") throw new Error(`not an object: ${line}`)
      const record = new Map(Object.entries(parsed))
      return {
        event: record.get("event"),
        epochMs: Number(record.get("epochMs")),
        pid: Number(record.get("pid")),
        processStartEpochMs: Number(record.get("processStartEpochMs")),
        detail: record.get("detail"),
      }
    })
}

describe("startup clock probe", () => {
  test("is off unless the environment names a file", () => {
    expect(startupClockProbePath({})).toBeUndefined()
    expect(startupClockProbePath({ CLAXEDO_DIAG_STARTUP_CLOCK: "" })).toBeUndefined()
    expect(startupClockProbePath({ CLAXEDO_DIAG_STARTUP_CLOCK: "   " })).toBeUndefined()
    expect(startupClockProbePath({ CLAXEDO_DIAG_STARTUP_CLOCK: " /tmp/clock.jsonl " })).toBe("/tmp/clock.jsonl")
  })

  test("stamps wall clock, because that is the only clock the renderer's timeOrigin shares", () => {
    const before = Date.now()
    const event = startupClockEvent("server-listening", { port: 1234 })
    const after = Date.now()

    expect(event.event).toBe("server-listening")
    expect(event.epochMs).toBeGreaterThanOrEqual(before)
    expect(event.epochMs).toBeLessThanOrEqual(after)
    expect(event.pid).toBe(process.pid)
    expect(event.processStartEpochMs).toBe(Math.round(performance.timeOrigin))
    expect(event.processStartEpochMs).toBeLessThanOrEqual(event.epochMs)
    expect(event.detail).toEqual({ port: 1234 })
  })

  test("omits detail entirely when there is none", () => {
    expect("detail" in startupClockEvent("main-server-ready-published")).toBe(false)
  })

  test("recording in a process that was never asked is a no-op it cannot fail at", () => {
    expect(startupClockProbePath(process.env)).toBeUndefined()
    expect(() => recordStartupClock("server-listening", { port: 1 })).not.toThrow()
  })

  // The module resolves its target at load and writes with `appendFileSync`, so
  // the only honest coverage for "does it actually record" is a real process
  // with a real environment. Two of them, appending to one file, because that
  // is exactly how the desktop uses it: main and the server child are separate
  // processes writing one run's clock.
  test("two processes append to one file, and neither writes when unasked", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "startup-clock-"))
    const target = path.join(directory, "startup-clock.jsonl")
    const module = path.join(import.meta.dir, "startup-clock-probe.ts")
    const script = `const { recordStartupClock } = await import(${JSON.stringify(module)}); recordStartupClock(process.env.PROBE_EVENT, { port: 1234 })`

    for (const event of ["server-listening", "main-server-ready-published"]) {
      const child = Bun.spawn({
        cmd: [process.execPath, "-e", script],
        env: { ...process.env, CLAXEDO_DIAG_STARTUP_CLOCK: target, PROBE_EVENT: event },
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(await child.exited).toBe(0)
    }

    const recorded = readLog(target)
    expect(recorded.map((entry) => entry.event)).toEqual(["server-listening", "main-server-ready-published"])
    expect(new Set(recorded.map((entry) => entry.pid)).size).toBe(2)
    for (const entry of recorded) {
      expect(entry.detail).toEqual({ port: 1234 })
      expect(entry.processStartEpochMs).toBeLessThanOrEqual(entry.epochMs)
    }
    expect(recorded[1].epochMs).toBeGreaterThanOrEqual(recorded[0].epochMs)

    // Unasked, in a directory of its own with nothing else in it: the probe must
    // leave NO file behind, not merely leave the named one alone. A probe that
    // quietly defaults to some path is a probe that is always on.
    const untouched = mkdtempSync(path.join(tmpdir(), "startup-clock-off-"))
    const silentEnv = { ...process.env, PROBE_EVENT: "server-listening" }
    delete silentEnv.CLAXEDO_DIAG_STARTUP_CLOCK
    const silent = Bun.spawn({
      cmd: [process.execPath, "-e", script],
      cwd: untouched,
      env: silentEnv,
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(await silent.exited).toBe(0)
    expect(readdirSync(untouched)).toEqual([])
    expect(readLog(target)).toHaveLength(2)

    rmSync(untouched, { recursive: true, force: true })
    rmSync(directory, { recursive: true, force: true })
  })
})
