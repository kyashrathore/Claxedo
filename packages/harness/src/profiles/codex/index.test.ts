import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { PluginProjection, ResolvedCredentials } from "../../contract"
import { prepareCodexProfile } from "."

const brokered: ResolvedCredentials = { providers: { codex: { baseUrl: "http://127.0.0.1:47501/v1", placeholder: "first", authMode: "api-key" } }, secrets: {}, leaseGeneration: "first" }
const ownLogin: ResolvedCredentials = { providers: {}, secrets: {}, leaseGeneration: "own" }
const machineOwner = { kind: "machine-owner" as const }
const noPlugins: PluginProjection = { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] }

async function plugin(root: string, name: string, version = "1.0.0") {
  const folder = path.join(root, name)
  await fs.mkdir(path.join(folder, ".codex-plugin"), { recursive: true })
  await fs.writeFile(path.join(folder, ".codex-plugin", "plugin.json"), JSON.stringify({ name, version }))
  await fs.writeFile(path.join(folder, "sentinel"), `${name} retained`)
  return { pluginInstanceId: name, root: folder, skillNames: [], dataRoot: root }
}

async function ownerHome(root: string) {
  const home = path.join(root, "owner-codex")
  await fs.mkdir(path.join(home, "skills", "owner-skill"), { recursive: true })
  await fs.mkdir(path.join(home, "sessions", "2026"), { recursive: true })
  await fs.writeFile(path.join(home, "config.toml"), 'model = "gpt-5.5"\n\n[mcp_servers.owner]\nurl = "http://127.0.0.1:47510/mcp"\n\n# BEGIN CLAXEDO CODEX PROFILE\n[marketplaces.stale]\n# END CLAXEDO CODEX PROFILE\n')
  await fs.writeFile(path.join(home, "AGENTS.md"), "Owner instructions\n")
  await fs.writeFile(path.join(home, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "owner-secret" }), { mode: 0o600 })
  await fs.writeFile(path.join(home, ".env"), "OPENAI_API_KEY=owner-env-secret\n")
  await fs.writeFile(path.join(home, "skills", "owner-skill", "SKILL.md"), "---\nname: owner-skill\n---\n")
  await fs.writeFile(path.join(home, "sessions", "2026", "rollout.jsonl"), "{}\n")
  return home
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const rows: Record<string, string> = {}
  const walk = async (folder: string) => {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name)
      if (entry.isDirectory()) await walk(file)
      else rows[path.relative(root, file)] = createHash("sha256").update(await fs.readFile(file)).digest("hex") + `:${(await fs.lstat(file)).mode}`
    }
  }
  await walk(root)
  return rows
}

test("an own-login session with plugins leaves the owner's Codex home byte-identical and composes a shared home", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-profile-own-"))
  try {
    const owner = await ownerHome(root)
    const roots = [await plugin(root, "one"), await plugin(root, "two")]
    const projection = { ...noPlugins, pluginRoots: roots }
    const before = await snapshot(owner)
    const first = await prepareCodexProfile({ homeRoot: path.join(root, "homes"), owner: machineOwner, credentials: ownLogin, projection, ownerHome: owner })
    expect(await snapshot(owner)).toEqual(before)
    expect(first.brokered).toBe(false)
    expect(path.dirname(first.home)).toBe(path.join(root, "homes"))
    const config = await fs.readFile(path.join(first.home, "config.toml"), "utf8")
    expect(config).toContain('model = "gpt-5.5"')
    expect(config).toContain("[mcp_servers.owner]")
    expect(config).not.toContain("marketplaces.stale")
    expect(config).toContain(`[marketplaces.claxedo-agent-plugins]`)
    expect(config).toContain('[plugins."one@claxedo-agent-plugins"]')
    expect(await fs.readFile(path.join(first.home, "AGENTS.md"), "utf8")).toBe("Owner instructions\n")
    expect(await fs.readFile(path.join(first.home, "skills", "owner-skill", "SKILL.md"), "utf8")).toContain("owner-skill")
    expect(await fs.readlink(path.join(first.home, "auth.json"))).toBe(path.join(await fs.realpath(owner), "auth.json"))
    expect(await fs.readdir(first.home)).not.toContain(".env")
    expect(await fs.readdir(first.home)).not.toContain("sessions")
    expect(await fs.readFile(path.join(first.home, "plugins", "cache", "claxedo-agent-plugins", "two", "1.0.0", "sentinel"), "utf8")).toBe("two retained")
    expect(await fs.readdir(owner)).not.toContain("marketplace")
    expect(await fs.readdir(owner)).not.toContain("plugins")
    const again = await prepareCodexProfile({ homeRoot: path.join(root, "homes"), owner: machineOwner, credentials: ownLogin, projection, ownerHome: owner })
    expect(again.home).toBe(first.home)
    expect(await snapshot(owner)).toEqual(before)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test("a plugin generation change and an owner config change update the shared home in place", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-profile-inplace-"))
  try {
    const owner = await ownerHome(root)
    const one = await plugin(root, "one")
    const two = await plugin(root, "two")
    const homeRoot = path.join(root, "homes")
    const first = await prepareCodexProfile({ homeRoot, owner: machineOwner, credentials: ownLogin, projection: { ...noPlugins, pluginRoots: [one, two] }, ownerHome: owner })
    await fs.writeFile(path.join(root, "two", "sentinel"), "two updated")
    await fs.rm(path.join(owner, "skills", "owner-skill"), { recursive: true })
    await fs.writeFile(path.join(owner, "config.toml"), 'model = "gpt-5.4"\n')
    const second = await prepareCodexProfile({ homeRoot, owner: machineOwner, credentials: ownLogin, projection: { generation: "g2", mcpServers: [], notApplied: [], pluginRoots: [one, two] }, ownerHome: owner })
    expect(second.home).toBe(first.home)
    expect(await fs.readFile(path.join(first.home, "plugins", "cache", "claxedo-agent-plugins", "two", "1.0.0", "sentinel"), "utf8")).toBe("two updated")
    expect(await fs.readdir(path.join(first.home, "skills"))).toEqual([])
    expect(await fs.readFile(path.join(first.home, "config.toml"), "utf8")).toContain('model = "gpt-5.4"')
    const third = await prepareCodexProfile({ homeRoot, owner: machineOwner, credentials: ownLogin, projection: { generation: "g3", mcpServers: [], notApplied: [], pluginRoots: [one] }, ownerHome: owner })
    expect(third.home).not.toBe(first.home)
    expect(await fs.readdir(path.join(third.home, "marketplace", "plugins"))).toEqual(["one"])
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test("the home is shared by owner, credential binding and plugin set", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-profile-key-"))
  try {
    const owner = await ownerHome(root)
    const homeRoot = path.join(root, "homes")
    const run = (input: Partial<Parameters<typeof prepareCodexProfile>[0]>) => prepareCodexProfile({ homeRoot, owner: machineOwner, credentials: ownLogin, projection: noPlugins, ownerHome: owner, ...input })
    const base = (await run({})).home
    expect((await run({})).home).toBe(base)
    expect((await run({ owner: { kind: "person", userId: "member" } })).home).not.toBe(base)
    expect((await run({ credentials: brokered })).home).not.toBe(base)
    expect((await run({ credentials: { ...brokered, leaseGeneration: "second", providers: { codex: { ...brokered.providers.codex!, placeholder: "rotated" } } } })).home)
      .toBe((await run({ credentials: brokered })).home)
    expect((await run({ credentials: brokered })).brokered).toBe(true)
    expect(await fs.readdir((await run({ credentials: brokered })).home)).not.toContain("auth.json")
    expect(await fs.readFile(path.join((await run({ credentials: brokered })).home, "config.toml"), "utf8")).not.toContain("mcp_servers.owner")
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test("the shared home refuses a symlink in its place and a mirror link that escapes the owner's home", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-profile-link-"))
  try {
    const owner = await ownerHome(root)
    const homeRoot = path.join(root, "homes")
    const { home } = await prepareCodexProfile({ homeRoot, owner: machineOwner, credentials: ownLogin, projection: noPlugins, ownerHome: owner })
    await fs.rm(home, { recursive: true })
    await fs.mkdir(path.join(root, "elsewhere"))
    await fs.symlink(path.join(root, "elsewhere"), home)
    await expect(prepareCodexProfile({ homeRoot, owner: machineOwner, credentials: ownLogin, projection: noPlugins, ownerHome: owner })).rejects.toThrow("symlink")
    expect(await fs.readdir(path.join(root, "elsewhere"))).toEqual([])
    await fs.rm(home)
    await fs.writeFile(path.join(root, "private.txt"), "private")
    await fs.symlink(path.join(root, "private.txt"), path.join(owner, "prompts-link"))
    await fs.mkdir(path.join(owner, "prompts"))
    await fs.symlink(path.join(root, "private.txt"), path.join(owner, "prompts", "leak.md"))
    await expect(prepareCodexProfile({ homeRoot, owner: machineOwner, credentials: ownLogin, projection: noPlugins, ownerHome: owner })).rejects.toThrow("escapes")
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test("a projected plugin link outside the plugin root is refused", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-plugin-link-"))
  try {
    const sample = await plugin(root, "sample")
    await fs.writeFile(path.join(root, "private.txt"), "private content")
    await fs.symlink(path.join(root, "private.txt"), path.join(sample.root, "linked-private.txt"))
    await expect(prepareCodexProfile({ homeRoot: path.join(root, "homes"), owner: machineOwner, credentials: brokered,
      projection: { ...noPlugins, pluginRoots: [sample] } })).rejects.toThrow("escapes")
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test("a brokered home retains a projected plugin cache during credential rotation with a private config", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-profile-brokered-"))
  try {
    const sample = await plugin(root, "sample", "2.0.0")
    const projection = { ...noPlugins, pluginRoots: [sample] }
    const homeRoot = path.join(root, "homes")
    const { home } = await prepareCodexProfile({ homeRoot, owner: machineOwner, projection, credentials: brokered })
    const cache = path.join(home, "plugins", "cache", "claxedo-agent-plugins", "sample", "2.0.0", "sentinel")
    expect(await fs.readFile(cache, "utf8")).toBe("sample retained")
    const rotated = { ...brokered, providers: { codex: { ...brokered.providers.codex!, placeholder: "second" } } }
    expect((await prepareCodexProfile({ homeRoot, owner: machineOwner, projection, credentials: rotated })).home).toBe(home)
    const config = await fs.readFile(path.join(home, "config.toml"), "utf8")
    expect(config).toContain("Bearer second")
    expect(config).toContain("[marketplaces.claxedo-agent-plugins]")
    expect(await fs.readFile(cache, "utf8")).toBe("sample retained")
    if (process.platform !== "win32") expect((await fs.stat(path.join(home, "config.toml"))).mode & 0o777).toBe(0o600)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
