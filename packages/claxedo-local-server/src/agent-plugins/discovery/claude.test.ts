import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { readClaudeInstalled } from "./claude"

const roots: string[] = []
async function temporaryHome() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-discovery-claude-"))
  roots.push(root)
  return root
}
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))))

async function writePluginsDir(home: string) {
  const pluginsDir = path.join(home, ".claude", "plugins")
  await fs.mkdir(pluginsDir, { recursive: true })
  return pluginsDir
}

describe("readClaudeInstalled", () => {
  test("lists installed plugins from installed_plugins.json, keyed name@marketplace", async () => {
    const home = await temporaryHome()
    const pluginsDir = await writePluginsDir(home)
    await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify({
      version: 2,
      plugins: {
        "frontend-design@claude-plugins-official": [{
          scope: "user",
          installPath: path.join(pluginsDir, "cache", "claude-plugins-official", "frontend-design", "0.1.0"),
          version: "0.1.0",
          installedAt: "2026-04-23T19:18:46.687Z",
        }],
      },
    }))
    await fs.writeFile(path.join(pluginsDir, "known_marketplaces.json"), JSON.stringify({
      "claude-plugins-official": {
        source: { source: "github", repo: "anthropics/claude-plugins-official" },
        installLocation: path.join(pluginsDir, "marketplaces", "claude-plugins-official"),
      },
    }))

    const entries = await readClaudeInstalled({ home })
    expect(entries).toEqual([{
      name: "frontend-design",
      version: "0.1.0",
      root: path.join(pluginsDir, "cache", "claude-plugins-official", "frontend-design", "0.1.0"),
      marketplace: "claude-plugins-official",
      ownedByClaxedo: false,
    }])
  })

  test("tolerates a missing plugins directory", async () => {
    const home = await temporaryHome()
    await expect(readClaudeInstalled({ home })).resolves.toEqual([])
  })

  test("tolerates malformed installed_plugins.json and a malformed known_marketplaces.json", async () => {
    const home = await temporaryHome()
    const pluginsDir = await writePluginsDir(home)
    await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), "{ not json")
    await fs.writeFile(path.join(pluginsDir, "known_marketplaces.json"), "{ also not json")
    await expect(readClaudeInstalled({ home })).resolves.toEqual([])
  })

  test("tolerates a plugins field that isn't a record and entries without an installPath", async () => {
    const home = await temporaryHome()
    const pluginsDir = await writePluginsDir(home)
    await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify({
      version: 2,
      plugins: {
        "broken@marketplace": [{ scope: "user" }],
        "empty@marketplace": [],
      },
    }))
    await expect(readClaudeInstalled({ home })).resolves.toEqual([])
  })
})
