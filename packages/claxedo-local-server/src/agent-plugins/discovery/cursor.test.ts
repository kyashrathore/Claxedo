import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { readCursorInstalled } from "./cursor"

const roots: string[] = []
async function temporaryHome() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-discovery-cursor-"))
  roots.push(root)
  return root
}
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))))

async function localRoot(home: string) {
  const root = path.join(home, ".cursor", "plugins", "local")
  await fs.mkdir(root, { recursive: true })
  return root
}

describe("readCursorInstalled", () => {
  test("lists a user-installed plugin by its manifest name and version", async () => {
    const home = await temporaryHome()
    const root = await localRoot(home)
    const entryRoot = path.join(root, "some-user-plugin")
    await fs.mkdir(entryRoot, { recursive: true })
    await fs.writeFile(path.join(entryRoot, "plugin.json"), JSON.stringify({ name: "review-helper", version: "2.3.1" }))

    const entries = await readCursorInstalled({ home })
    expect(entries).toEqual([{
      name: "review-helper",
      version: "2.3.1",
      root: entryRoot,
      ownedByClaxedo: false,
    }])
  })

  test("falls back to the directory name when there is no manifest", async () => {
    const home = await temporaryHome()
    const root = await localRoot(home)
    const entryRoot = path.join(root, "no-manifest-plugin")
    await fs.mkdir(entryRoot, { recursive: true })
    await fs.writeFile(path.join(entryRoot, "README.md"), "hello")

    const entries = await readCursorInstalled({ home })
    expect(entries).toEqual([{ name: "no-manifest-plugin", root: entryRoot, ownedByClaxedo: false }])
  })

  test("flags a Claxedo-owned entry (carrying the ownership marker) as ownedByClaxedo without excluding it", async () => {
    const home = await temporaryHome()
    const root = await localRoot(home)
    const entryRoot = path.join(root, "claxedo--context7--907dc4875d4d")
    await fs.mkdir(entryRoot, { recursive: true })
    await fs.writeFile(path.join(entryRoot, "plugin.json"), JSON.stringify({ name: "context7", version: "1.0.0" }))
    await fs.writeFile(path.join(entryRoot, ".claxedo-agent-plugin.json"), JSON.stringify({
      owner: "claxedo-agent-plugins",
      directory: "claxedo--context7--907dc4875d4d",
      pluginInstanceId: '["claxedo","context7"]',
    }))

    const entries = await readCursorInstalled({ home })
    expect(entries).toEqual([{
      name: "context7",
      version: "1.0.0",
      root: entryRoot,
      ownedByClaxedo: true,
    }])
  })

  test("tolerates a missing local plugins directory", async () => {
    const home = await temporaryHome()
    await expect(readCursorInstalled({ home })).resolves.toEqual([])
  })

  test("tolerates malformed manifest JSON and skips non-directory entries", async () => {
    const home = await temporaryHome()
    const root = await localRoot(home)
    const entryRoot = path.join(root, "broken-manifest")
    await fs.mkdir(entryRoot, { recursive: true })
    await fs.writeFile(path.join(entryRoot, "plugin.json"), "{ not json")
    await fs.writeFile(path.join(root, "stray-file.txt"), "not a plugin directory")

    const entries = await readCursorInstalled({ home })
    expect(entries).toEqual([{ name: "broken-manifest", root: entryRoot, ownedByClaxedo: false }])
  })
})
