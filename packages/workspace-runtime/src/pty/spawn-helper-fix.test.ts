/**
 * Verifies that:
 *  1. node-pty fails with "posix_spawnp" when spawn-helper lacks the execute bit
 *  2. Restoring the execute bit makes node-pty spawn work again
 *  3. ensureSpawnHelper() programmatically fixes the permission
 */
import { describe, test, expect, afterAll } from "bun:test"
import * as fs from "fs"
import { ensureSpawnHelper, spawnHelperCandidates, spawnHelperPath } from "./spawn-helper-fix"

// spawnHelperPath() answers "where WOULD it be", not "does it exist" — some
// node-pty prebuilds (linux-x64 among them) ship without spawn-helper, and the
// module-level statSync then threw outside any test as an unhandled error.
const candidate = spawnHelperPath()
const helper = candidate && fs.existsSync(candidate) ? candidate : undefined
const originalMode = helper ? fs.statSync(helper).mode : 0

afterAll(() => {
  if (!helper) return
  try {
    fs.chmodSync(helper, originalMode)
  } catch {}
})

const isLinux = process.platform === "linux"

describe.skipIf(!helper || process.platform === "win32")("spawn-helper permission fix", () => {
  test.skipIf(!isLinux)("node-pty fails when spawn-helper has no execute bit", async () => {
    fs.chmodSync(helper!, 0o644)
    const { spawn } = await import("node-pty")
    expect(() => {
      const pty = spawn("/bin/echo", ["hello"], {
        name: "xterm-256color",
        cwd: "/tmp",
      })
      pty.kill()
    }).toThrow(/posix_spawnp/)
  })

  test.skipIf(!isLinux)("node-pty succeeds after restoring execute bit", async () => {
    fs.chmodSync(helper!, 0o755)
    const { spawn } = await import("node-pty")
    const pty = spawn("/bin/echo", ["hello"], {
      name: "xterm-256color",
      cwd: "/tmp",
    })
    expect(pty.pid).toBeGreaterThan(0)
    pty.kill()
  })

  test("ensureSpawnHelper() fixes missing execute permission", async () => {
    fs.chmodSync(helper!, 0o644)
    expect(fs.statSync(helper!).mode & 0o111).toBe(0)

    await ensureSpawnHelper()

    const mode = fs.statSync(helper!).mode
    expect(mode & 0o111).not.toBe(0)
  })

  test("ensureSpawnHelper() is a no-op when permission is already correct", async () => {
    fs.chmodSync(helper!, 0o755)
    const modeBefore = fs.statSync(helper!).mode

    await ensureSpawnHelper()

    const modeAfter = fs.statSync(helper!).mode
    expect(modeAfter).toBe(modeBefore)
  })
})

describe("spawnHelperCandidates", () => {
  test("maps an asar path to its unpacked counterpart", () => {
    const asarPath = "/app/Claxedo Dev.app/Contents/Resources/app.asar/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper"
    expect(spawnHelperCandidates(asarPath)).toEqual([
      asarPath,
      "/app/Claxedo Dev.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
    ])
  })

  test("leaves plain and already-unpacked paths alone", () => {
    const plain = "/repo/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper"
    expect(spawnHelperCandidates(plain)).toEqual([plain])
    const unpacked = "/app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper"
    expect(spawnHelperCandidates(unpacked)).toEqual([unpacked])
  })
})
