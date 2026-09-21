import { describe, expect, spyOn, test } from "bun:test"
import type { ChildProcess } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { drainHarnessProcessGroup, resolveHarnessCommand } from "./windows-process"

const denied = () => Object.assign(new Error("permission denied"), { code: "EPERM" })
const missing = () => Object.assign(new Error("no such group"), { code: "ESRCH" })

test.skipIf(process.platform === "win32")("a transient Darwin zombie-group EPERM still waits for authoritative group absence", async () => {
  let inspections = 0
  const kill = spyOn(process, "kill").mockImplementation((_pid, signal) => {
    if (signal !== 0) throw denied()
    if (++inspections < 3) throw denied()
    throw missing()
  })
  try {
    await drainHarnessProcessGroup({ pid: 987654 } as ChildProcess, 100)
    expect(inspections).toBe(3)
  } finally { kill.mockRestore() }
})

test.skipIf(process.platform === "win32")("persistent group EPERM never counts as successful retirement", async () => {
  const kill = spyOn(process, "kill").mockImplementation(() => { throw denied() })
  try {
    await expect(drainHarnessProcessGroup({ pid: 987654 } as ChildProcess, 20)).rejects.toThrow("did not terminate: permission denied")
  } finally { kill.mockRestore() }
})

const win32 = "win32" as const

function shimDir(files: Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), "windows-shim-"))
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
  return dir
}

const NPM_SHIM = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ") ELSE (",
  '  SET "_prog=node"',
  ")",
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\agent\\bin\\cli.js" %*',
  "",
].join("\r\n")

describe("resolveHarnessCommand", () => {
  test("leaves real executables and non-Windows launches untouched", () => {
    expect(resolveHarnessCommand("agent.exe", ["a", "b"], {}, "C:\\work", win32)).toEqual({
      command: "agent.exe",
      args: ["a", "b"],
    })
    expect(resolveHarnessCommand("agent.cmd", ["a"], {}, "/work", "darwin")).toEqual({
      command: "agent.cmd",
      args: ["a"],
    })
  })

  test("resolves an npm shim to its script and keeps every argument literal", () => {
    const dir = shimDir({
      "agent.cmd": NPM_SHIM,
      "node_modules/agent/bin/cli.js": "// cli\n",
    })
    const args = ["--flag", "a&b|c>d", "%PATH%", 'say "hi"', "sp ace"]
    const launch = resolveHarnessCommand(path.join(dir, "agent.cmd"), args, {}, dir, win32)
    expect(launch.command).toBe(process.execPath)
    expect(launch.args).toEqual([path.join(dir, "node_modules/agent/bin/cli.js"), ...args])
  })

  test("prefers the script target over the node.exe probe when both exist", () => {
    const dir = shimDir({
      "agent.cmd": NPM_SHIM,
      "node.exe": "x",
      "node_modules/agent/bin/cli.js": "// cli\n",
    })
    const launch = resolveHarnessCommand(path.join(dir, "agent.cmd"), [], {}, dir, win32)
    expect(launch.command).toBe(process.execPath)
    expect(launch.args).toEqual([path.join(dir, "node_modules/agent/bin/cli.js")])
  })

  test("resolves a shim that wraps an executable directly", () => {
    const dir = shimDir({
      "agent.cmd": '@echo off\r\n"%~dp0real.exe" %*\r\n',
      "real.exe": "MZ",
    })
    const launch = resolveHarnessCommand(path.join(dir, "agent.cmd"), ["x&y"], {}, dir, win32)
    expect(launch.command).toBe(path.join(dir, "real.exe"))
    expect(launch.args).toEqual(["x&y"])
  })

  test("resolves a bare shim name through the launch PATH", () => {
    const dir = shimDir({
      "agent.cmd": '@echo off\r\nnode "%~dp0impl.cjs" %*\r\n',
      "impl.cjs": "// impl\n",
    })
    const launch = resolveHarnessCommand("agent.cmd", ["--go"], { PATH: dir }, "/nonexistent-cwd", win32)
    expect(launch.command).toBe(process.execPath)
    expect(launch.args).toEqual([path.join(dir, "impl.cjs"), "--go"])
  })

  test("follows a shim that delegates to another shim", () => {
    const dir = shimDir({
      "outer.cmd": '@echo off\r\n"%~dp0inner.cmd" %*\r\n',
      "inner.cmd": '@echo off\r\n"%~dp0real.exe" %*\r\n',
      "real.exe": "MZ",
    })
    const launch = resolveHarnessCommand(path.join(dir, "outer.cmd"), ["v"], {}, dir, win32)
    expect(launch).toEqual({ command: path.join(dir, "real.exe"), args: ["v"] })
  })

  test("refuses a shim that names no resolvable executable", () => {
    const dir = shimDir({ "agent.cmd": "@echo off\r\necho hello\r\n" })
    expect(() => resolveHarnessCommand(path.join(dir, "agent.cmd"), [], {}, dir, win32)).toThrow(
      "does not resolve to a real executable",
    )
  })

  test("refuses a self-referencing shim instead of recursing forever", () => {
    const dir = shimDir({ "agent.cmd": '@echo off\r\n"%~dp0agent.cmd" %*\r\n' })
    expect(() => resolveHarnessCommand(path.join(dir, "agent.cmd"), [], {}, dir, win32)).toThrow("nests deeper")
  })

  test("refuses a shim that does not exist", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "windows-shim-"))
    expect(() => resolveHarnessCommand(path.join(dir, "missing.cmd"), [], {}, dir, win32)).toThrow("was not found")
  })
})
