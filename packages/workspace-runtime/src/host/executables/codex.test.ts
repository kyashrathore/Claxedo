import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { requireCodexExecutable, resolveCodexExecutable } from "./codex"

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

  function npmLauncher(prefix: string): string {
    const script = makeExecutable(path.join(prefix, "lib", "node_modules", "@openai", "codex", "bin", "codex.js"))
    fs.mkdirSync(path.join(prefix, "bin"), { recursive: true })
    fs.symlinkSync(path.relative(path.join(prefix, "bin"), script), path.join(prefix, "bin", "codex"))
    return path.join(prefix, "bin")
  }

  test("follows the macOS npm launcher to the native binary nested in its platform package", () => {
    const prefix = temporaryRoot()
    const bin = npmLauncher(prefix)
    const binary = makeExecutable(path.join(prefix, "lib", "node_modules", "@openai", "codex", "node_modules", "@openai",
      "codex-darwin-arm64", "vendor", "aarch64-apple-darwin", "bin", "codex"))

    expect(resolveCodexExecutable({ PATH: bin }, "darwin", "arm64")).toBe(fs.realpathSync(binary))
  })

  test("follows the Linux launcher to a hoisted platform package, as bun's isolated install lays it out", () => {
    const prefix = temporaryRoot()
    const bin = npmLauncher(prefix)
    const binary = makeExecutable(path.join(prefix, "lib", "node_modules", "@openai", "codex-linux-x64",
      "vendor", "x86_64-unknown-linux-musl", "bin", "codex"))

    expect(resolveCodexExecutable({ PATH: bin }, "linux", "x64")).toBe(fs.realpathSync(binary))
  })

  test("refuses a launcher whose platform package carries no binary for this machine", () => {
    const prefix = temporaryRoot()
    const bin = npmLauncher(prefix)
    makeExecutable(path.join(prefix, "lib", "node_modules", "@openai", "codex-linux-x64", "vendor", "x86_64-unknown-linux-musl", "bin", "codex"))

    expect(resolveCodexExecutable({ PATH: bin }, "linux", "arm64")).toBeUndefined()
    expect(() => requireCodexExecutable({ PATH: bin }, "darwin", "arm64")).toThrow(/npm install -g @openai\/codex/)
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
