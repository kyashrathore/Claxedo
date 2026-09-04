import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import { spawnSync } from "node:child_process"

assert.equal(typeof globalThis.Bun, "undefined", "Run this probe with Node or Electron, not Bun")
const sdkPath = import.meta.resolve("@opencode-ai/sdk")
const sdkRequire = createRequire(sdkPath)
const coreRoot = sdkRequire.resolve.paths("@opencode-ai/core")
  .map(directory => path.join(directory, "@opencode-ai/core"))
  .find(directory => fs.existsSync(path.join(directory, "package.json")))
assert.ok(coreRoot, "SDK core dependency must be installed")
const coreManifest = JSON.parse(fs.readFileSync(path.join(coreRoot, "package.json"), "utf8"))
assert.equal(coreManifest.version, "0.0.0-beta-18684")
const lockPath = path.join(coreRoot, coreManifest.exports["./*"].import.replace("*", "util/process-lock-ffi.node"))
const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-node-sdk-"))
const cwd = process.cwd()
const directory = path.join(root, "workspace")
fs.mkdirSync(directory)
Object.assign(process.env, {
  HOME: root, XDG_CONFIG_HOME: path.join(root, "config"),
  XDG_DATA_HOME: path.join(root, "data"), XDG_CACHE_HOME: path.join(root, "cache"),
  OPENCODE_TEST_HOME: root, OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
})
process.chdir(directory)
let sdk
try {
  if (process.platform === "darwin" || process.platform === "linux") {
    const lock = (await import(lockPath))[process.platform === "darwin" ? "lockDarwin" : "lockLinux"]
    const file = path.join(root, "probe.lock")
    const fd = fs.openSync(file, "a+")
    try {
      assert.deepEqual(lock(fd), { acquired: true })
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import fs from "node:fs";
        const binding = await import(${JSON.stringify(lockPath)});
        const fd = fs.openSync(${JSON.stringify(file)}, "a+");
        console.log(JSON.stringify(binding.${process.platform === "darwin" ? "lockDarwin" : "lockLinux"}(fd)));
        fs.closeSync(fd);
      `], { env: process.env, encoding: "utf8", timeout: 15_000 })
      assert.equal(child.status, 0, child.stderr)
      assert.deepEqual(JSON.parse(child.stdout), { acquired: false, held: true })
    } finally { fs.closeSync(fd) }
    const next = fs.openSync(file, "a+")
    try { assert.deepEqual(lock(next), { acquired: true }) } finally { fs.closeSync(next) }
    const invalid = lock(-1)
    assert.equal(invalid.acquired, false)
    assert.equal(invalid.held, false)
    assert.equal(typeof invalid.code, "number")
  }
  const { OpenCode } = await import(sdkPath)
  const database = { path: path.join(root, "opencode.db") }
  sdk = await OpenCode.create({ database, config: { content: "{}" } })
  assert.equal((await sdk.health.get()).healthy, true)
  const location = { directory }
  assert.ok(Array.isArray(await sdk.config.get({ location })))
  assert.ok(Array.isArray((await sdk.agent.list({ location })).data))
  await sdk.provider.list({ location })
  const created = await sdk.session.create({ title: "Node persistence probe", location })
  await sdk.close()
  sdk = await OpenCode.create({ database, config: { content: "{}" } })
  const restored = await sdk.session.get({ sessionID: created.id })
  assert.equal(restored.id, created.id)
  assert.equal(restored.title, "Node persistence probe")
  console.log(JSON.stringify({ ok: true, node: process.versions.node, electron: process.versions.electron ?? null }))
} finally {
  await sdk?.close()
  process.chdir(cwd)
  fs.rmSync(root, { recursive: true, force: true })
}
