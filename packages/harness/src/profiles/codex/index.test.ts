import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { prepareCodexProfile } from "."

test("brokered Codex home retains a projected plugin cache during credential rotation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-profile-"))
  const home = path.join(root, "home")
  const plugin = path.join(root, "plugin")
  await fs.mkdir(path.join(plugin, ".codex-plugin"), { recursive: true })
  await fs.writeFile(path.join(plugin, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "sample", version: "2.0.0" }))
  await fs.writeFile(path.join(plugin, "sentinel"), "plugin retained")
  const projection = { generation: "g1", mcpServers: [], notApplied: [], pluginRoots: [{ pluginInstanceId: "sample", root: plugin, dataRoot: root }] }
  const credentials = { providers: { codex: { baseUrl: "http://127.0.0.1:47501/v1", placeholder: "first", authMode: "api-key" as const } }, secrets: {}, leaseGeneration: "first" }
  try {
    await prepareCodexProfile({ home, projection, credentials })
    const cache = path.join(home, "plugins", "cache", "claxedo-agent-plugins", "sample", "2.0.0", "sentinel")
    expect(await fs.readFile(cache, "utf8")).toBe("plugin retained")
    const rotated = { ...credentials, providers: { codex: { ...credentials.providers.codex, placeholder: "second" } } }
    await prepareCodexProfile({ home, projection, credentials: rotated })
    const config = await fs.readFile(path.join(home, "config.toml"), "utf8")
    expect(config).toContain("Bearer second")
    expect(config).toContain("[marketplaces.claxedo-agent-plugins]")
    expect(await fs.readFile(cache, "utf8")).toBe("plugin retained")
    if (process.platform !== "win32") expect((await fs.stat(path.join(home, "config.toml"))).mode & 0o777).toBe(0o600)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test("brokered Codex home refuses a symlink without writing through it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-profile-link-"))
  const target = path.join(root, "target")
  const home = path.join(root, "home")
  await fs.mkdir(target)
  await fs.symlink(target, home)
  try {
    await expect(prepareCodexProfile({ home, credentials: { providers: { codex: { baseUrl: "http://127.0.0.1", placeholder: "secret", authMode: "api-key" } }, secrets: {}, leaseGeneration: "g1" },
      projection: { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] } })).rejects.toThrow("symlink")
    expect(await fs.readdir(target)).toEqual([])
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test("Codex plugin projection refuses links outside the plugin root", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-plugin-link-"))
  const home = path.join(root, "home")
  const plugin = path.join(root, "plugin")
  const privateFile = path.join(root, "private.txt")
  await fs.mkdir(path.join(plugin, ".codex-plugin"), { recursive: true })
  await fs.writeFile(path.join(plugin, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "sample", version: "1.0.0" }))
  await fs.writeFile(privateFile, "private content")
  await fs.symlink(privateFile, path.join(plugin, "linked-private.txt"))
  try {
    await expect(prepareCodexProfile({ home,
      credentials: { providers: { codex: { baseUrl: "http://127.0.0.1", placeholder: "placeholder", authMode: "api-key" } }, secrets: {}, leaseGeneration: "g1" },
      projection: { generation: "g1", mcpServers: [], notApplied: [], pluginRoots: [{ pluginInstanceId: "sample", root: plugin, dataRoot: root }] },
    })).rejects.toThrow("escapes")
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
