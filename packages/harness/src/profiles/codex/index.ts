import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { asRecordOrEmpty, asString } from "@claxedo/helpers/guards"
import { writePrivateFileAtomic } from "@claxedo/helpers/fs"
import { HARNESS_TABLE, type ProviderProjection } from "@claxedo/agent-runtime-contract"
import type { PluginProjection, ResolvedCredentials, TurnActor } from "../../contract"
import { selectedProviderProjection } from "../../contract"
import { CLAXEDO_MARKETPLACE, codexHomeKey, copyTreeAtomically, mirrorOwnerCodexHome } from "./home"

const START = "# BEGIN CLAXEDO CODEX PROFILE"
const END = "# END CLAXEDO CODEX PROFILE"

export type CodexProfile = { home: string; brokered: boolean }

export type CodexProfileInput = {
  homeRoot: string
  owner: TurnActor
  credentials: ResolvedCredentials
  projection: PluginProjection
  ownerHome?: string
}

function validatedCodexPluginSegment(name: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") throw new Error(`Invalid Codex plugin name ${name}`)
  return name
}

async function readOptional(file: string): Promise<string> {
  return fs.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return ""
    throw error
  })
}

async function marketplace(home: string, projection: PluginProjection): Promise<string> {
  const source = path.join(home, "marketplace")
  const cache = path.join(home, "plugins", "cache", CLAXEDO_MARKETPLACE)
  if (!projection.pluginRoots.length) {
    await fs.rm(source, { recursive: true, force: true })
    await fs.rm(cache, { recursive: true, force: true })
    return ""
  }
  const manifest = path.join(source, ".agents", "plugins")
  await fs.mkdir(manifest, { recursive: true, mode: 0o700 })
  await fs.mkdir(path.join(source, "plugins"), { recursive: true, mode: 0o700 })
  await fs.mkdir(cache, { recursive: true, mode: 0o700 })
  const names = new Set<string>()
  const plugins = []
  for (const item of projection.pluginRoots) {
    const fields = asRecordOrEmpty(JSON.parse(await fs.readFile(path.join(item.root, ".codex-plugin", "plugin.json"), "utf8")))
    const name = validatedCodexPluginSegment(asString(fields.name) ?? "")
    const version = validatedCodexPluginSegment(asString(fields.version) ?? "1.0.0")
    if (names.has(name)) throw new Error(`Duplicate Codex plugin ${name}`)
    names.add(name)
    const pluginRoot = await fs.realpath(item.root)
    await copyTreeAtomically(item.root, path.join(source, "plugins", name), pluginRoot)
    await fs.mkdir(path.join(cache, name), { recursive: true, mode: 0o700 })
    await copyTreeAtomically(item.root, path.join(cache, name, version), pluginRoot)
    for (const stale of await fs.readdir(path.join(cache, name))) if (stale !== version) await fs.rm(path.join(cache, name, stale), { recursive: true, force: true })
    plugins.push({ name, source: { source: "local", path: `./plugins/${name}` } })
  }
  for (const folder of [path.join(source, "plugins"), cache]) {
    for (const stale of await fs.readdir(folder)) if (!names.has(stale)) await fs.rm(path.join(folder, stale), { recursive: true, force: true })
  }
  await writePrivateFileAtomic(path.join(manifest, "marketplace.json"), JSON.stringify({ name: CLAXEDO_MARKETPLACE, plugins }))
  return [
    `[marketplaces.${CLAXEDO_MARKETPLACE}]`,
    'source_type = "local"',
    `source = ${JSON.stringify(source)}`,
    ...plugins.flatMap(({ name }) => [`[plugins.${JSON.stringify(`${name}@${CLAXEDO_MARKETPLACE}`)}]`, "enabled = true"]),
  ].join("\n")
}

function brokerFragment(selected: { baseUrl: string; apiPath?: string; placeholder: string }): string {
  return [
    "check_for_update_on_startup = false",
    'model_provider = "broker"',
    "[model_providers.broker]",
    'name = "Claxedo credential broker"',
    `base_url = ${JSON.stringify(`${selected.baseUrl}${selected.apiPath ?? ""}`)}`,
    'wire_api = "responses"',
    "requires_openai_auth = false",
    `http_headers = { Authorization = ${JSON.stringify(`Bearer ${selected.placeholder}`)} }`,
  ].join("\n")
}

function withoutClaxedoBlock(content: string): string {
  const begin = content.indexOf(START)
  const end = content.indexOf(END)
  if ((begin === -1) !== (end === -1) || (begin >= 0 && end < begin)) throw new Error("Codex profile block is damaged")
  return begin < 0 ? content.trimEnd() : `${content.slice(0, begin)}${content.slice(end + END.length)}`.trim()
}

export function codexCredential(credentials: ResolvedCredentials): ProviderProjection | undefined {
  return selectedProviderProjection(credentials, HARNESS_TABLE.codex.providerIds)
}

export async function prepareCodexProfile(input: CodexProfileInput): Promise<CodexProfile> {
  const selected = codexCredential(input.credentials)
  if (selected && "unavailable" in selected) throw new Error(`Codex account unavailable: ${selected.reason}`)
  const brokered = Boolean(selected)
  const ownerHome = input.ownerHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex")
  const home = path.join(input.homeRoot, codexHomeKey(input.owner, selected && !("unavailable" in selected) ? selected : undefined, input.projection))
  const existing = await fs.lstat(home).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (existing?.isSymbolicLink()) throw new Error("Codex home cannot be a symlink")
  await fs.mkdir(home, { recursive: true, mode: 0o700 })
  await fs.chmod(home, 0o700)
  if (!brokered) await mirrorOwnerCodexHome(ownerHome, home)
  const fragments = [await marketplace(home, input.projection)]
  if (selected && !("unavailable" in selected)) fragments.unshift(brokerFragment(selected))
  const retained = brokered ? "" : withoutClaxedoBlock(await readOptional(path.join(ownerHome, "config.toml")))
  const block = fragments.filter(Boolean).join("\n\n")
  const next = [retained, block ? `${START}\n${block}\n${END}` : ""].filter(Boolean).join("\n\n")
  await writePrivateFileAtomic(path.join(home, "config.toml"), `${next}\n`)
  return { home, brokered }
}
