import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { readCodexInstalled } from "./codex"

const roots: string[] = []
async function temporaryCodexHome() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-discovery-codex-"))
  roots.push(root)
  return root
}
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))))

async function cacheDir(codexHome: string, marketplace: string, name: string, version: string) {
  const dir = path.join(codexHome, "plugins", "cache", marketplace, name, version)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

describe("readCodexInstalled", () => {
  test("merges a config.toml plugin declaration with its cache directory", async () => {
    const codexHome = await temporaryCodexHome()
    const root = await cacheDir(codexHome, "openai-bundled", "chrome", "26.831.20005")
    await fs.writeFile(path.join(codexHome, "config.toml"), [
      '[marketplaces.openai-bundled]',
      'source_type = "local"',
      'source = "/somewhere"',
      "",
      '[plugins."chrome@openai-bundled"]',
      "enabled = true",
      "",
    ].join("\n"))

    const entries = await readCodexInstalled({ home: os.homedir(), codexHome })
    expect(entries).toEqual([{
      name: "chrome",
      version: "26.831.20005",
      root,
      marketplace: "openai-bundled",
      ownedByClaxedo: false,
    }])
  })

  test("includes a cache-only plugin not declared in config.toml", async () => {
    const codexHome = await temporaryCodexHome()
    const root = await cacheDir(codexHome, "openai-curated", "github", "1.0.0")
    await fs.writeFile(path.join(codexHome, "config.toml"), "model = \"gpt\"\n")

    const entries = await readCodexInstalled({ home: os.homedir(), codexHome })
    expect(entries).toEqual([{ name: "github", version: "1.0.0", root, marketplace: "openai-curated", ownedByClaxedo: false }])
  })

  test("includes a config-declared plugin with no matching cache directory", async () => {
    const codexHome = await temporaryCodexHome()
    await fs.mkdir(path.join(codexHome, "plugins", "cache"), { recursive: true })
    await fs.writeFile(path.join(codexHome, "config.toml"), '[plugins."vercel@openai-curated"]\nenabled = true\n')

    const entries = await readCodexInstalled({ home: os.homedir(), codexHome })
    expect(entries).toEqual([{
      name: "vercel",
      root: path.join(codexHome, "plugins", "cache", "openai-curated", "vercel"),
      marketplace: "openai-curated",
      ownedByClaxedo: false,
    }])
  })

  test("excludes the Claxedo-managed marker block and marketplace cache directory entirely", async () => {
    const codexHome = await temporaryCodexHome()
    await cacheDir(codexHome, "claxedo-agent-plugins", "context7", "1.0.0")
    await cacheDir(codexHome, "openai-bundled", "chrome", "1.0.0")
    await fs.writeFile(path.join(codexHome, "config.toml"), [
      '[plugins."chrome@openai-bundled"]',
      "enabled = true",
      "",
      "# BEGIN CLAXEDO AGENT PLUGINS",
      "[marketplaces.claxedo-agent-plugins]",
      'source_type = "local"',
      'source = "/generation/root"',
      "",
      '[plugins."context7@claxedo-agent-plugins"]',
      "enabled = true",
      "",
      "# END CLAXEDO AGENT PLUGINS",
      "",
    ].join("\n"))

    const entries = await readCodexInstalled({ home: os.homedir(), codexHome })
    expect(entries.map((entry) => entry.name)).toEqual(["chrome"])
    expect(entries.every((entry) => entry.marketplace !== "claxedo-agent-plugins")).toBe(true)
  })

  test("defaults codexHome to <home>/.codex when not given", async () => {
    const home = await temporaryCodexHome()
    const codexHome = path.join(home, ".codex")
    await cacheDir(codexHome, "openai-bundled", "chrome", "1.0.0")

    const entries = await readCodexInstalled({ home })
    expect(entries).toHaveLength(1)
    expect(entries[0]!.name).toBe("chrome")
  })

  test("tolerates a missing config.toml and a missing cache directory", async () => {
    const codexHome = await temporaryCodexHome()
    await expect(readCodexInstalled({ home: os.homedir(), codexHome })).resolves.toEqual([])
  })

  test("tolerates a config.toml that is not TOML at all", async () => {
    const codexHome = await temporaryCodexHome()
    await fs.writeFile(path.join(codexHome, "config.toml"), "this is not { valid [ toml at all")
    await expect(readCodexInstalled({ home: os.homedir(), codexHome })).resolves.toEqual([])
  })
})
