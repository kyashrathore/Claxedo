import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { requireCodexExecutable, resolveCodexExecutable } from "./executable"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-executable-"))
  roots.push(root)
  return root
}

function makeExecutable(candidate: string): string {
  fs.mkdirSync(path.dirname(candidate), { recursive: true })
  fs.writeFileSync(candidate, "#!/bin/sh\n")
  fs.chmodSync(candidate, 0o755)
  return candidate
}

describe("Codex executable resolution", () => {
  test("resolves the executable from PATH on Posix", () => {
    const directory = temporaryRoot()
    const binary = makeExecutable(path.join(directory, "codex"))

    expect(resolveCodexExecutable({ PATH: directory }, "linux", "x64")).toBe(binary)
  })

  test("follows a Windows npm cmd shim to the official native binary", () => {
    const directory = temporaryRoot()
    makeExecutable(path.join(directory, "codex.cmd"))
    const binary = makeExecutable(path.join(
      directory,
      "node_modules",
      "@openai",
      "codex",
      "node_modules",
      "@openai",
      "codex-win32-x64",
      "vendor",
      "x86_64-pc-windows-msvc",
      "bin",
      "codex.exe",
    ))

    expect(resolveCodexExecutable({ PATH: directory, PATHEXT: ".EXE;.CMD" }, "win32", "x64")).toBe(binary)
  })

  test("uses a native codex.exe directly on Windows", () => {
    const directory = temporaryRoot()
    const binary = makeExecutable(path.join(directory, "codex.exe"))

    expect(resolveCodexExecutable({ Path: directory, PATHEXT: ".EXE;.CMD" }, "win32", "x64")).toBe(binary)
  })

  test("throws an actionable error when Codex is absent", () => {
    expect(() => requireCodexExecutable({ PATH: "" }, "linux", "x64")).toThrow(
      /npm install -g @openai\/codex/,
    )
  })
})
