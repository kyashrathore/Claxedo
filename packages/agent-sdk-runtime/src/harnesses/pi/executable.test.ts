import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { resolvePiExecutable, verifyPiExecutable } from "./executable"

test("npm shims resolve the package's declared binary instead of its unbundled source entry", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-npm-shim-"))
  const packageRoot = path.join(root, "node_modules/@earendil-works/pi-coding-agent")
  const executable = path.join(packageRoot, "dist/bundle/cli.js")
  const shim = path.join(root, "pi.cmd")
  try {
    await fs.mkdir(path.dirname(executable), { recursive: true })
    await fs.writeFile(shim, "@echo off\n", { mode: 0o700 })
    await fs.writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ type: "module", bin: { pi: "dist/bundle/cli.js" } }),
    )
    await fs.writeFile(executable, 'console.log("0.85.1")')
    await fs.writeFile(path.join(packageRoot, "dist/cli.js"), 'throw new Error("unbundled entry")')
    expect(resolvePiExecutable({ PI_EXECUTABLE: shim, PATH: "" })).toBe(executable)
    await verifyPiExecutable(resolvePiExecutable({ PI_EXECUTABLE: shim, PATH: "" })!)
    await fs.rm(executable)
    expect(resolvePiExecutable({ PI_EXECUTABLE: shim, PATH: "" })).toBeUndefined()
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test.skipIf(process.platform !== "win32")("a project-local npm shim in node_modules/.bin resolves the package one level up", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-local-shim-"))
  const packageRoot = path.join(root, "node_modules/@earendil-works/pi-coding-agent")
  const executable = path.join(packageRoot, "dist/bundle/cli.js")
  const bin = path.join(root, "node_modules/.bin")
  try {
    await fs.mkdir(path.dirname(executable), { recursive: true })
    await fs.mkdir(bin, { recursive: true })
    await fs.writeFile(path.join(bin, "pi.cmd"), "@echo off\n", { mode: 0o700 })
    await fs.writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ type: "module", bin: { pi: "dist/bundle/cli.js" } }))
    await fs.writeFile(executable, 'console.log("0.85.1")')
    expect(resolvePiExecutable({ PI_EXECUTABLE: path.join(bin, "pi.cmd"), PATH: "" })).toBe(executable)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("accepts a readable pinned JavaScript entry and rejects a different protocol version", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-executable-"))
  try {
    const good = path.join(root, "pi.mjs")
    const old = path.join(root, "old.mjs")
    await fs.writeFile(good, 'console.log("0.85.1")', { mode: 0o600 })
    await fs.writeFile(old, 'console.log("0.75.5")', { mode: 0o600 })
    expect(resolvePiExecutable({ PI_EXECUTABLE: good, PATH: "" })).toBe(good)
    expect(resolvePiExecutable({ PI_EXECUTABLE: path.join(root, "missing"), PATH: "" })).toBeUndefined()
    await verifyPiExecutable(good)
    await expect(verifyPiExecutable(old)).rejects.toThrow("Unsupported Pi version 0.75.5; expected 0.85.1")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("a JavaScript entry runs under Node, not under the Bun process that launches it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-node-entry-"))
  try {
    const entry = path.join(root, "cli.mjs")
    await fs.writeFile(entry, 'console.log(process.versions.bun ? "bun" : "0.85.1")', { mode: 0o600 })
    await verifyPiExecutable(entry)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("a version probe that fails names its exit code and stderr", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-probe-exit-"))
  try {
    const entry = path.join(root, "cli.mjs")
    await fs.writeFile(entry, 'process.stderr.write("dyld: missing libfoo\\n"); process.exit(3)', { mode: 0o600 })
    await expect(verifyPiExecutable(entry)).rejects.toThrow(
      "Cannot check Pi version: exited with code 3; stderr: dyld: missing libfoo.",
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("a version probe killed by a signal names the signal", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-probe-signal-"))
  try {
    const entry = path.join(root, "cli.mjs")
    await fs.writeFile(entry, 'process.kill(process.pid, "SIGKILL")', { mode: 0o600 })
    await expect(verifyPiExecutable(entry)).rejects.toThrow("Cannot check Pi version: killed by SIGKILL.")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
