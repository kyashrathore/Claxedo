import { afterEach, describe, expect, test } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { ensureSpawnHelper, spawnHelperCandidates } from "./spawn-helper-fix"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })))
})

async function helper(mode: number) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "spawn-helper-fix-"))
  tempDirs.push(dir)
  const file = path.join(dir, "spawn-helper")
  await fs.promises.writeFile(file, "fixture")
  await fs.promises.chmod(file, mode)
  return file
}

describe("spawn-helper permission fix", () => {
  test("restores missing execute permission", async () => {
    const file = await helper(0o644)

    await ensureSpawnHelper(file)

    expect((await fs.promises.stat(file)).mode & 0o111).not.toBe(0)
  })

  test("leaves an executable helper unchanged", async () => {
    const file = await helper(0o755)
    const before = (await fs.promises.stat(file)).mode

    await ensureSpawnHelper(file)

    expect((await fs.promises.stat(file)).mode).toBe(before)
  })

  test("repairs both archive and unpacked helpers in packaged apps", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "spawn-helper-asar-"))
    tempDirs.push(dir)
    const archived = path.join(dir, "app.asar", "node_modules", "@lydell", "node-pty-darwin-arm64", "spawn-helper")
    const unpacked = path.join(dir, "app.asar.unpacked", "node_modules", "@lydell", "node-pty-darwin-arm64", "spawn-helper")
    await Promise.all([archived, unpacked].map(async (file) => {
      await fs.promises.mkdir(path.dirname(file), { recursive: true })
      await fs.promises.writeFile(file, "fixture")
      await fs.promises.chmod(file, 0o644)
    }))

    await ensureSpawnHelper(archived)

    expect((await fs.promises.stat(archived)).mode & 0o111).not.toBe(0)
    expect((await fs.promises.stat(unpacked)).mode & 0o111).not.toBe(0)
  })

  test("ignores a missing helper", async () => {
    await expect(ensureSpawnHelper("/missing/spawn-helper")).resolves.toBeUndefined()
  })
})

describe("spawnHelperCandidates", () => {
  test("maps an asar path to its unpacked counterpart", () => {
    const asarPath = "/app/Claxedo Dev.app/Contents/Resources/app.asar/node_modules/@lydell/node-pty-darwin-arm64/prebuilds/darwin-arm64/spawn-helper"
    expect(spawnHelperCandidates(asarPath)).toEqual([
      asarPath,
      "/app/Claxedo Dev.app/Contents/Resources/app.asar.unpacked/node_modules/@lydell/node-pty-darwin-arm64/prebuilds/darwin-arm64/spawn-helper",
    ])
  })

  test("leaves plain and already-unpacked paths alone", () => {
    const plain = "/repo/node_modules/@lydell/node-pty-darwin-arm64/prebuilds/darwin-arm64/spawn-helper"
    expect(spawnHelperCandidates(plain)).toEqual([plain])
    const unpacked = "/app/Contents/Resources/app.asar.unpacked/node_modules/@lydell/node-pty-darwin-arm64/prebuilds/darwin-arm64/spawn-helper"
    expect(spawnHelperCandidates(unpacked)).toEqual([unpacked])
  })
})
