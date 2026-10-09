import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import type { PluginProjection, ResolvedCredentials } from "../../contract"
import { PINNED_CODEX } from "../../../e2e/harness/pinned-codex"
import { releasePort, reservePort } from "../../../e2e/harness/ports"
import { startScriptedModelServer } from "../../../e2e/harness/scripted-model-server"
import { prepareCodexProfile } from "."

const brokered: ResolvedCredentials = { machineLoginAllowed: true, accountOwner: "fixture-owner", providers: { openai: { baseUrl: "http://127.0.0.1:47501/v1", placeholder: "first", authMode: "api-key" } }, secrets: {}, leaseGeneration: "first" }
const ownLogin: ResolvedCredentials = { machineLoginAllowed: true, accountOwner: "fixture-owner", providers: {}, secrets: {}, leaseGeneration: "own" }
const noPlugins: PluginProjection = { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] }

const removeDirectoryLink = (link: string) => process.platform === "win32" ? fs.rmdir(link) : fs.rm(link)

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

const WINDOWS_COLD_HOME_COMPOSE_MS = 20_000

test("an own-login session with plugins leaves the owner's Codex home byte-identical and composes a shared home", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-profile-own-"))
  try {
    const owner = await ownerHome(root)
    const roots = [await plugin(root, "one"), await plugin(root, "two")]
    const projection = { ...noPlugins, pluginRoots: roots }
    const before = await snapshot(owner)
    const first = await prepareCodexProfile({ homeRoot: path.join(root, "homes"), credentials: ownLogin, projection, ownerHome: owner })
    expect(await snapshot(owner)).toEqual(before)
    expect(first.modelProvider).toBeUndefined()
    expect(path.dirname(first.store)).toBe(path.join(root, "homes"))
    expect(path.dirname(first.home)).toBe(path.join(first.store, "homes"))
    const config = await fs.readFile(path.join(first.home, "config.toml"), "utf8")
    expect(config).toContain('model = "gpt-5.5"')
    expect(config).toContain("[mcp_servers.owner]")
    expect(config).not.toContain("marketplaces.stale")
    expect(config).toContain(`[marketplaces.claxedo-agent-plugins]`)
    expect(config).not.toContain("[plugins.")
    expect(first.plugins).toEqual(["one@claxedo-agent-plugins", "two@claxedo-agent-plugins"])
    expect(await fs.readFile(path.join(first.home, "AGENTS.md"), "utf8")).toBe("Owner instructions\n")
    expect(await fs.readFile(path.join(first.home, "skills", "owner-skill", "SKILL.md"), "utf8")).toContain("owner-skill")
    expect(await fs.readlink(path.join(first.home, "auth.json"))).toBe(path.join(await fs.realpath(owner), "auth.json"))
    expect(await fs.readdir(first.home)).not.toContain(".env")
    expect(await fs.readlink(path.join(first.home, "sessions"))).toBe(path.join(first.store, "sessions"))
    expect(await fs.readdir(path.join(first.store, "sessions"))).toEqual([])
    expect(await fs.readFile(path.join(first.home, "plugins", "cache", "claxedo-agent-plugins", "two", "1.0.0", "sentinel"), "utf8")).toBe("two retained")
    expect(await fs.readdir(owner)).not.toContain("marketplace")
    expect(await fs.readdir(owner)).not.toContain("plugins")
    const again = await prepareCodexProfile({ homeRoot: path.join(root, "homes"), credentials: ownLogin, projection, ownerHome: owner })
    expect(again.home).toBe(first.home)
    expect(await snapshot(owner)).toEqual(before)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
}, WINDOWS_COLD_HOME_COMPOSE_MS)

async function codexLogin(codexHome: string, home: string, apiKey: string): Promise<void> {
  const child = spawn(PINNED_CODEX, ["login", "--with-api-key"], { env: { PATH: process.env.PATH ?? "", HOME: home, CODEX_HOME: codexHome }, stdio: ["pipe", "ignore", "pipe"] })
  let stderr = ""
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString() })
  child.stdin.end(`${apiKey}\n`)
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve) })
  if (code !== 0) throw new Error(`codex login exited ${code}: ${stderr}`)
}

test("only the own-login home links the owner's auth, and a login in a brokered home is never written to a file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-auth-boundary-"))
  try {
    const owner = await ownerHome(root)
    const ownerAuth = path.join(owner, "auth.json")
    const before = await snapshot(owner)
    const homeRoot = path.join(root, "homes")
    const own = await prepareCodexProfile({ homeRoot, credentials: ownLogin, projection: noPlugins, ownerHome: owner })
    expect(await fs.readlink(path.join(own.home, "auth.json"))).toBe(await fs.realpath(ownerAuth))
    const { home } = await prepareCodexProfile({ homeRoot, credentials: brokered, projection: noPlugins, ownerHome: owner })
    expect(home).not.toBe(own.home)
    expect(await fs.readdir(home)).not.toContain("auth.json")
    await codexLogin(home, root, "sk-brokered-login")
    expect(await fs.readdir(home)).not.toContain("auth.json")
    await prepareCodexProfile({ homeRoot, credentials: brokered, projection: noPlugins, ownerHome: owner })
    expect(await fs.readdir(home)).not.toContain("auth.json")
    expect(await snapshot(owner)).toEqual(before)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
}, 60_000)

async function codexExec(codexHome: string, home: string, cwd: string, args: string[]): Promise<number | null> {
  const child = spawn(PINNED_CODEX, ["exec", ...args], { cwd, env: { PATH: process.env.PATH ?? "", HOME: home, CODEX_HOME: codexHome }, stdio: ["ignore", "ignore", "pipe"] })
  let stderr = ""
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString() })
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve) })
  if (code !== 0) throw new Error(`codex exec exited ${code}: ${stderr.slice(-800)}`)
  return code
}

test("a plugin version bump in a selected execution keeps the home, so a thread started before it resumes after", async () => {
  const port = await reservePort()
  const model = await startScriptedModelServer({ port, red: false })
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bump-"))
  try {
    const owner = await ownerHome(root)
    await fs.writeFile(path.join(owner, "config.toml"), [
      "check_for_update_on_startup = false", 'model = "gpt-4.1"', 'model_provider = "scripted"', "[model_providers.scripted]",
      'name = "scripted"', `base_url = "${model.v1Url}"`, 'wire_api = "responses"', "requires_openai_auth = false",
      'http_headers = { Authorization = "Bearer bump" }', "",
    ].join("\n"))
    const work = path.join(root, "work")
    await fs.mkdir(work)
    const homeRoot = path.join(root, "homes")
    const selected = (hash: string, version: string) => plugin(path.join(root, version), "bumped", version)
      .then((bumped) => ({ ...noPlugins, pluginRoots: [bumped], pluginSelection: { mode: "selected" as const, selectionHash: hash } }))
    const before = await prepareCodexProfile({ homeRoot, credentials: ownLogin, projection: await selected("digest-v1", "1.0.0"), ownerHome: owner })
    await codexExec(before.home, root, work, ["--skip-git-repo-check", "BUMPFIRST start the thread"])
    const after = await prepareCodexProfile({ homeRoot, credentials: ownLogin, projection: await selected("digest-v2", "2.0.0"), ownerHome: owner })
    expect(after.home).toBe(before.home)
    expect(await fs.readdir(path.join(after.home, "plugins", "cache", "claxedo-agent-plugins", "bumped"))).toEqual(["2.0.0"])
    model.requests.splice(0)
    await codexExec(after.home, root, work, ["--skip-git-repo-check", "resume", "--last", "BUMPSECOND continue it"])
    expect(model.requests.some((request) => JSON.stringify(request.body).includes("BUMPFIRST"))).toBe(true)
  } finally {
    await model.close()
    releasePort(port)
    await fs.rm(root, { recursive: true, force: true })
  }
}, 120_000)

test("selected execution excludes personal plugin config and cache from the shared home", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-selected-"))
  try {
    const owner = await ownerHome(root)
    await fs.appendFile(path.join(owner, "config.toml"), '\n[marketplaces.personal]\nsource = "/personal"\n[plugins."unselected@personal"]\nenabled = true\n')
    await fs.mkdir(path.join(owner, "plugins/cache/personal/unselected"), { recursive: true })
    const selected = await plugin(root, "selected")
    const projection = { ...noPlugins, pluginRoots: [selected], pluginSelection: { mode: "selected" as const, selectionHash: "selection-a" } }
    const before = await snapshot(owner)
    const { home, plugins } = await prepareCodexProfile({ homeRoot: path.join(root, "homes"), credentials: ownLogin, projection, ownerHome: owner })
    expect(plugins).toEqual(["selected@claxedo-agent-plugins"])
    const config = await fs.readFile(path.join(home, "config.toml"), "utf8")
    expect(config).not.toContain("unselected")
    expect(config).not.toContain("marketplaces.personal")
    expect(config).toContain("[marketplaces.claxedo-agent-plugins]")
    expect(await fs.readdir(path.join(home, "plugins/cache"))).toEqual(["claxedo-agent-plugins"])
    const cache = path.join(home, "plugins/cache/claxedo-agent-plugins")
    const inode = (await fs.stat(cache)).ino
    await prepareCodexProfile({ homeRoot: path.join(root, "homes"), credentials: ownLogin, projection, ownerHome: owner })
    expect((await fs.stat(cache)).ino).toBe(inode)
    expect(await snapshot(owner)).toEqual(before)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test("a plugin generation change, a changed plugin set and an owner config change update the shared home in place", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-profile-inplace-"))
  try {
    const owner = await ownerHome(root)
    const one = await plugin(root, "one")
    const two = await plugin(root, "two")
    const homeRoot = path.join(root, "homes")
    const first = await prepareCodexProfile({ homeRoot, credentials: ownLogin, projection: { ...noPlugins, pluginRoots: [one, two] }, ownerHome: owner })
    await fs.writeFile(path.join(root, "two", "sentinel"), "two updated")
    await fs.rm(path.join(owner, "skills", "owner-skill"), { recursive: true })
    await fs.writeFile(path.join(owner, "config.toml"), 'model = "gpt-5.4"\n')
    const second = await prepareCodexProfile({ homeRoot, credentials: ownLogin, projection: { generation: "g2", mcpServers: [], notApplied: [], pluginRoots: [one, two] }, ownerHome: owner })
    expect(second.home).toBe(first.home)
    expect(await fs.readFile(path.join(first.home, "plugins", "cache", "claxedo-agent-plugins", "two", "1.0.0", "sentinel"), "utf8")).toBe("two updated")
    expect(await fs.readdir(path.join(first.home, "skills"))).toEqual([])
    expect(await fs.readFile(path.join(first.home, "config.toml"), "utf8")).toContain('model = "gpt-5.4"')
    const third = await prepareCodexProfile({ homeRoot, credentials: ownLogin, projection: { generation: "g3", mcpServers: [], notApplied: [], pluginRoots: [one] }, ownerHome: owner })
    expect(third.home).toBe(first.home)
    expect(third.plugins).toEqual(["one@claxedo-agent-plugins"])
    expect((await fs.readdir(path.join(third.home, "marketplace", "plugins"))).sort()).toEqual(["one", "two"])
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test("the home is shared by account holder, credential binding and plugin selection mode, whatever the plugin set", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-profile-key-"))
  try {
    const owner = await ownerHome(root)
    const homeRoot = path.join(root, "homes")
    const run = (input: Partial<Parameters<typeof prepareCodexProfile>[0]>) => prepareCodexProfile({ homeRoot, credentials: ownLogin, projection: noPlugins, ownerHome: owner, ...input })
    const base = (await run({})).home
    expect((await run({})).home).toBe(base)
    expect((await run({ projection: { ...noPlugins, pluginRoots: [await plugin(root, "added")] } })).home).toBe(base)
    expect((await run({ projection: { ...noPlugins, pluginSelection: { mode: "selected", selectionHash: "one" } } })).home).not.toBe(base)
    expect((await run({ credentials: { ...brokered, accountOwner: "member" } })).home)
      .not.toBe((await run({ credentials: brokered })).home)
    expect((await run({ credentials: brokered })).home).not.toBe(base)
    expect((await run({ credentials: { ...brokered, leaseGeneration: "second", providers: { openai: { ...brokered.providers.openai!, placeholder: "rotated" } } } })).home)
      .toBe((await run({ credentials: brokered })).home)
    expect((await run({ credentials: brokered })).modelProvider).toBe("broker")
    expect(await fs.readdir((await run({ credentials: brokered })).home)).not.toContain("auth.json")
    expect(await fs.readFile(path.join((await run({ credentials: brokered })).home, "config.toml"), "utf8")).not.toContain("mcp_servers.owner")
  } finally { await fs.rm(root, { recursive: true, force: true }) }
}, 60_000)

test("every home of one owner links one conversation store and names it Codex's sqlite home, and another owner's homes link their own", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-profile-store-"))
  try {
    const owner = await ownerHome(root)
    const homeRoot = path.join(root, "homes")
    const own = await prepareCodexProfile({ homeRoot, credentials: ownLogin, projection: noPlugins, ownerHome: owner })
    const switched = await prepareCodexProfile({ homeRoot, credentials: brokered, projection: { ...noPlugins, pluginSelection: { mode: "selected", selectionHash: "one" } } })
    const member = await prepareCodexProfile({ homeRoot, credentials: { ...brokered, accountOwner: "member" }, projection: noPlugins })
    expect(switched.home).not.toBe(own.home)
    expect(switched.store).toBe(own.store)
    expect(member.store).not.toBe(own.store)
    for (const profile of [own, switched]) {
      expect(profile.configOverrides).toEqual([`sqlite_home=${JSON.stringify(own.store)}`])
      for (const name of ["sessions", "archived_sessions", "thread-writer-locks", "memories", "session_index.jsonl"]) {
        expect(await fs.readlink(path.join(profile.home, name))).toBe(path.join(own.store, name))
      }
    }
    await fs.mkdir(path.join(own.home, "sessions", "2026"))
    await fs.appendFile(path.join(own.home, "session_index.jsonl"), "{}\n")
    expect(await fs.readdir(path.join(switched.home, "sessions"))).toEqual(["2026"])
    expect(await fs.readFile(path.join(switched.home, "session_index.jsonl"), "utf8")).toBe("{}\n")
    expect(await fs.readdir(path.join(member.home, "sessions"))).toEqual([])
    expect(await fs.readdir(path.join(owner, "sessions"))).toEqual(["2026"])
    expect(await fs.readdir(path.join(owner, "sessions", "2026"))).toEqual(["rollout.jsonl"])
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test("the shared home refuses a symlink in its place and a mirror link that escapes the owner's home", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-profile-link-"))
  try {
    const owner = await ownerHome(root)
    const homeRoot = path.join(root, "homes")
    const { home } = await prepareCodexProfile({ homeRoot, credentials: ownLogin, projection: noPlugins, ownerHome: owner })
    await fs.rm(home, { recursive: true })
    await fs.mkdir(path.join(root, "elsewhere"))
    await fs.symlink(path.join(root, "elsewhere"), home)
    await expect(prepareCodexProfile({ homeRoot, credentials: ownLogin, projection: noPlugins, ownerHome: owner })).rejects.toThrow("symlink")
    expect(await fs.readdir(path.join(root, "elsewhere"))).toEqual([])
    await removeDirectoryLink(home)
    const store = path.dirname(path.dirname(home))
    await fs.rename(store, path.join(root, "moved-store"))
    await fs.symlink(path.join(root, "moved-store"), store)
    await expect(prepareCodexProfile({ homeRoot, credentials: ownLogin, projection: noPlugins, ownerHome: owner })).rejects.toThrow("symlink")
    await removeDirectoryLink(store)
    await fs.writeFile(path.join(root, "private.txt"), "private")
    await fs.symlink(path.join(root, "private.txt"), path.join(owner, "prompts-link"))
    await fs.mkdir(path.join(owner, "prompts"))
    await fs.symlink(path.join(root, "private.txt"), path.join(owner, "prompts", "leak.md"))
    await expect(prepareCodexProfile({ homeRoot, credentials: ownLogin, projection: noPlugins, ownerHome: owner })).rejects.toThrow("escapes")
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test("a projected plugin link outside the plugin root is refused", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-plugin-link-"))
  try {
    const sample = await plugin(root, "sample")
    await fs.writeFile(path.join(root, "private.txt"), "private content")
    await fs.symlink(path.join(root, "private.txt"), path.join(sample.root, "linked-private.txt"))
    await expect(prepareCodexProfile({ homeRoot: path.join(root, "homes"), credentials: brokered,
      projection: { ...noPlugins, pluginRoots: [sample] } })).rejects.toThrow("escapes")
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test("a brokered home retains a projected plugin cache during credential rotation with a private config that never carries the placeholder", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-profile-brokered-"))
  try {
    const sample = await plugin(root, "sample", "2.0.0")
    const projection = { ...noPlugins, pluginRoots: [sample] }
    const homeRoot = path.join(root, "homes")
    const { home } = await prepareCodexProfile({ homeRoot, projection, credentials: brokered })
    const cache = path.join(home, "plugins", "cache", "claxedo-agent-plugins", "sample", "2.0.0", "sentinel")
    expect(await fs.readFile(cache, "utf8")).toBe("sample retained")
    const rotated = { ...brokered, providers: { openai: { ...brokered.providers.openai!, placeholder: "second" } } }
    expect((await prepareCodexProfile({ homeRoot, projection, credentials: rotated })).home).toBe(home)
    const config = await fs.readFile(path.join(home, "config.toml"), "utf8")
    expect(config).not.toContain("first")
    expect(config).not.toContain("second")
    expect(config).toContain("requires_openai_auth = true")
    expect(config).toContain("[marketplaces.claxedo-agent-plugins]")
    expect(await fs.readFile(cache, "utf8")).toBe("sample retained")
    if (process.platform !== "win32") expect((await fs.stat(path.join(home, "config.toml"))).mode & 0o777).toBe(0o600)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
