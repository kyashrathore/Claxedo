import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { describeBuildLog, runBunBuild } from "./bun-build"

function workspace(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bun-build-test-"))
  for (const [name, contents] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), contents)
  return dir
}

describe("describeBuildLog", () => {
  test("names the source location when the log carries one", () => {
    expect(describeBuildLog({
      level: "error",
      message: 'Could not resolve: "./missing"',
      position: { file: "/tmp/entry.ts", line: 3, column: 8 },
    })).toBe('error: Could not resolve: "./missing" (/tmp/entry.ts:3:8)')
  })

  test("omits the location rather than inventing one", () => {
    expect(describeBuildLog({ level: "warning", message: "no position here" })).toBe("warning: no position here")
  })
})

describe("runBunBuild", () => {
  test("returns the build output unchanged on success", async () => {
    const dir = workspace({ "entry.ts": "export const value = 1\n" })
    const result = await runBunBuild("should not be raised", {
      entrypoints: [path.join(dir, "entry.ts")],
      outdir: path.join(dir, "out"),
      target: "node",
    })

    expect(result.success).toBe(true)
    expect(result.outputs.length).toBeGreaterThan(0)
  })

  // The whole reason the helper exists: `Bun.build` rejects rather than
  // returning `success: false`, so a failure reaches callers as a thrown
  // AggregateError whose messages nothing was reading.
  test("raises the label with the position-aware log lines", async () => {
    const dir = workspace({ "entry.ts": 'import "./absent.js"\n' })

    const error = await runBunBuild("Widget bundle failed", {
      entrypoints: [path.join(dir, "entry.ts")],
      outdir: path.join(dir, "out"),
      target: "node",
    }).then(() => undefined, (err: unknown) => err)

    expect(error).toBeInstanceOf(Error)
    const message = error instanceof Error ? error.message : ""
    expect(message.startsWith("Widget bundle failed\n")).toBe(true)
    expect(message).toContain("Could not resolve")
    // The line and column are the part every other call site was dropping.
    expect(message).toMatch(/entry\.ts:1:\d+\)/)
    // The original is preserved rather than replaced by the summary.
    expect(error instanceof Error ? error.cause : undefined).toBeInstanceOf(AggregateError)
  })

  // Not every failure has a source location, and the formatter must not invent
  // one. A missing entrypoint is the case that produces a `BuildMessage` with
  // no `position` at all — measured, not assumed.
  test("omits the location for a failure with no source position", async () => {
    const dir = workspace({})

    const error = await runBunBuild("Widget bundle failed", {
      entrypoints: [path.join(dir, "absent-entry.ts")],
      outdir: path.join(dir, "out"),
      target: "node",
    }).then(() => undefined, (err: unknown) => err)

    const message = error instanceof Error ? error.message : ""
    expect(message).toContain("ModuleNotFound")
    expect(message).not.toContain("undefined:undefined")
    expect(message).not.toMatch(/:\d+:\d+\)/)
  })

  test("runs onFailure before raising, so build side effects are undone", async () => {
    const dir = workspace({ "entry.ts": 'import "./absent.js"\n' })
    const staging = path.join(dir, "dist.pending-1234")
    fs.mkdirSync(staging)

    const error = await runBunBuild("Widget bundle failed", {
      entrypoints: [path.join(dir, "entry.ts")],
      outdir: staging,
      target: "node",
    }, {
      onFailure: () => fs.rmSync(staging, { recursive: true, force: true }),
    }).then(() => undefined, (err: unknown) => err)

    expect(error).toBeInstanceOf(Error)
    expect(fs.existsSync(staging)).toBe(false)
  })

  test("leaves side effects alone when no cleanup is supplied", async () => {
    const dir = workspace({ "entry.ts": 'import "./absent.js"\n' })
    const staging = path.join(dir, "dist.pending-5678")
    fs.mkdirSync(staging)

    await runBunBuild("Widget bundle failed", {
      entrypoints: [path.join(dir, "entry.ts")],
      outdir: staging,
      target: "node",
    }).then(() => undefined, () => undefined)

    expect(fs.existsSync(staging)).toBe(true)
  })
})

describe("describeBuildLog fallbacks", () => {
  // `String(someObject)` is `[object Object]` — a build failure reported as no
  // information at all, which is the defect this helper exists to stop.
  test("serializes an unrecognized log rather than stringifying it to [object Object]", () => {
    expect(describeBuildLog({ unexpected: "shape" })).toBe('error: {"unexpected":"shape"}')
    expect(describeBuildLog({ nested: { a: 1 } })).not.toContain("[object Object]")
  })

  test("names values JSON cannot represent", () => {
    expect(describeBuildLog(Symbol("nope"))).toBe("[unrecognized build log]")
    expect(describeBuildLog(() => {})).toBe("[unrecognized build log]")
  })

  test("passes primitives through", () => {
    expect(describeBuildLog("plain text")).toBe("plain text")
    expect(describeBuildLog(undefined)).toBe("undefined")
  })
})
