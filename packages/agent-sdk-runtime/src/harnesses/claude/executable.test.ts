import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { CLAUDE_EXECUTABLE_ENV, requireClaudeExecutable, resolveClaudeExecutable } from "./executable"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-exec-"))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

function makeExecutable(dir: string, name: string): string {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  fs.writeFileSync(file, "#!/bin/sh\n")
  fs.chmodSync(file, 0o755)
  return file
}

describe("resolveClaudeExecutable", () => {
  test("finds `claude` on PATH", () => {
    const dir = path.join(root, "onpath")
    makeExecutable(dir, "claude")
    // The resolver joins with the SIMULATED platform's separator (posix for
    // darwin), so on a Windows host the candidate is `<win-dir>/claude`, not
    // the host path.join. Build the expectation the same way.
    expect(resolveClaudeExecutable({ PATH: dir }, "darwin", root)).toBe(path.posix.join(dir, "claude"))
  })

  test("uses the native-installer location when PATH misses it", () => {
    const home = path.join(root, "home")
    const bin = makeExecutable(path.join(home, ".local", "bin"), "claude")
    expect(resolveClaudeExecutable({ PATH: "" }, "linux", home)).toBe(bin)
  })

  test("an explicit override wins over PATH", () => {
    const override = makeExecutable(path.join(root, "custom"), "claude")
    const onPath = path.join(root, "ignored")
    makeExecutable(onPath, "claude")
    expect(
      resolveClaudeExecutable({ [CLAUDE_EXECUTABLE_ENV]: override, PATH: onPath }, "darwin", root),
    ).toBe(override)
  })

  test("a broken explicit override resolves to undefined", () => {
    expect(
      resolveClaudeExecutable({ [CLAUDE_EXECUTABLE_ENV]: "/does/not/exist/claude", PATH: "" }, "darwin", root),
    ).toBeUndefined()
  })

  test("requireClaudeExecutable throws an actionable error when absent", () => {
    // win32 looks for `claude.exe`, which the posix temp home does not contain.
    expect(() => requireClaudeExecutable({ PATH: "" }, "win32", path.join(root, "empty"))).toThrow(
      /not installed or not on PATH/,
    )
  })
})
