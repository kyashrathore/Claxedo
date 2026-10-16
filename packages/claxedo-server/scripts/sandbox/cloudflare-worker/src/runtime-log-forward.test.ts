import { spawnSync } from "node:child_process"
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { WorkspaceContainer } from "./container-api"
import { forwardRuntimeLog, runtimeLogExcerpt } from "./runtime-log-forward"

const LAUNCH = { id: "launch-1", launchedAt: 0, ready: true }

describe("operator log excerpt", () => {
  test("blanks credentials with the runtime log redactor, a private key across its lines too", () => {
    const text = [
      "2026-10-16T12:18:31 WARN  boot env CLAXEDO_API_TOKEN=cxt_live_secret next",
      "fatal: https://x-access-token:ghs_0123456789abcdefghijABCDEFGHIJ@github.com/acme/private.git",
      "-----BEGIN PRIVATE KEY-----",
      "MIIEvQIBADANBg",
      "-----END PRIVATE KEY-----",
    ].join("\n")
    const { lines } = runtimeLogExcerpt(text)
    expect(lines).toEqual([
      "2026-10-16T12:18:31 WARN  boot env CLAXEDO_API_TOKEN=[REDACTED] next",
      "fatal: https://[REDACTED]@github.com/acme/private.git",
      "[REDACTED PEM]",
    ])
    expect(lines.join("\n")).not.toMatch(/cxt_live_secret|ghs_|MIIE/)
  })

  test("forwards at most 40 lines of at most 500 characters and counts the rest as dropped", () => {
    const flood = Array.from({ length: 100 }, (_, n) => `2026-10-16T12:18:31 WARN  line ${n} ${"x".repeat(1_000)}`).join("\n")
    const { lines, dropped } = runtimeLogExcerpt(flood)
    expect(lines).toHaveLength(16)
    expect(lines.every((line) => line.length === 500)).toBe(true)
    expect(dropped).toBe(84)
    const short = Array.from({ length: 100 }, (_, n) => `ERROR ${n}`).join("\n")
    expect(runtimeLogExcerpt(short)).toMatchObject({ dropped: 60 })
    expect(runtimeLogExcerpt(short).lines).toHaveLength(40)
  })
})

/** A container whose `exec` runs on this machine's shell, so the read script is exercised as the container runs it. */
function shellContainer() {
  return {
    async exec(argv: string[]) {
      const [program = "", ...args] = argv
      const done = spawnSync(program, args)
      const bytes = (buffer: Buffer) => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
      return { exitCode: Promise.resolve(done.status ?? 1), output: async () => ({ stdout: bytes(done.stdout), stderr: bytes(done.stderr), exitCode: done.status ?? 1 }) }
    },
  } as unknown as WorkspaceContainer
}

describe("runtime log forwarding", () => {
  let dir: string | undefined
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
    vi.restoreAllMocks()
  })

  function operatorFile(content: string) {
    dir = mkdtempSync(join(tmpdir(), "runtime-log-forward-"))
    const file = join(dir, "operator.log")
    writeFileSync(file, content)
    return file
  }

  test("forwards each new complete line once, and holds a line still being written until it ends", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const file = operatorFile("2026-10-16T12:18:21 WARN  first\n2026-10-16T12:18:22 WARN  Session authority unav")
    const container = shellContainer()
    const first = await forwardRuntimeLog(container, file, LAUNCH, undefined, { workspaceId: "ws_1", epoch: 2 })
    expect(warn.mock.calls).toEqual([["workspace-runtime log", { workspaceId: "ws_1", epoch: 2, launchId: "launch-1", lines: ["2026-10-16T12:18:21 WARN  first"], dropped: 0, skippedBytes: 0 }]])
    appendFileSync(file, "ailable service=session-authority action=write ms=5003 cause=timeout\n")
    const second = await forwardRuntimeLog(container, file, LAUNCH, first, { workspaceId: "ws_1", epoch: 2 })
    expect(warn.mock.calls[1]?.[1]).toMatchObject({ lines: ["2026-10-16T12:18:22 WARN  Session authority unavailable service=session-authority action=write ms=5003 cause=timeout"] })
    expect(await forwardRuntimeLog(container, file, LAUNCH, second, {})).toEqual(second)
    expect(warn).toHaveBeenCalledTimes(2)
  })

  test("a cursor of another launch starts this launch's log from its beginning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const file = operatorFile("ERROR from the new launch\n")
    await forwardRuntimeLog(shellContainer(), file, LAUNCH, { launchId: "launch-0", offset: 9_999 }, {})
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ lines: ["ERROR from the new launch"], skippedBytes: 0 })
  })

  test("a backlog past one read skips to its newest 64 KiB and says how much it skipped", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const line = `2026-10-16T12:18:20 WARN  ${"é".repeat(40)}\n`
    const content = Buffer.from(line.repeat(2_000) + "ERROR the newest\n")
    const file = operatorFile(content.toString())
    const firstWholeLine = content.indexOf(10, content.length - 65_536) + 1
    const cursor = await forwardRuntimeLog(shellContainer(), file, LAUNCH, undefined, {})
    expect(cursor).toEqual({ launchId: "launch-1", offset: content.length })
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ skippedBytes: firstWholeLine, dropped: expect.any(Number) })
  })

  test("a launch not yet ready, whose runtime has not opened its log, forwards nothing and keeps its place", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    dir = mkdtempSync(join(tmpdir(), "runtime-log-forward-"))
    expect(await forwardRuntimeLog(shellContainer(), join(dir, "operator.log"), { ...LAUNCH, ready: false }, undefined, {})).toEqual({ launchId: "launch-1", offset: 0 })
    expect(warn).not.toHaveBeenCalled()
  })

  test("a ready launch with no log, which the runtime opens before it answers, is reported once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    dir = mkdtempSync(join(tmpdir(), "runtime-log-forward-"))
    const file = join(dir, "operator.log")
    const first = await forwardRuntimeLog(shellContainer(), file, LAUNCH, undefined, { workspaceId: "ws_1", epoch: 2 })
    await forwardRuntimeLog(shellContainer(), file, LAUNCH, first, { workspaceId: "ws_1", epoch: 2 })
    expect(warn.mock.calls).toEqual([["workspace-runtime operator log missing", { workspaceId: "ws_1", epoch: 2, launchId: "launch-1", file }]])
  })
})
