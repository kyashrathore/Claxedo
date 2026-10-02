import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parse, stringify } from "smol-toml"
import { asRecordOrEmpty, asString } from "@claxedo/helpers/guards"
import { lstatIfExists, readTextIfExists, writePrivateFileAtomic } from "@claxedo/helpers/fs"
import { HARNESS_TABLE, type ProviderProjection } from "@claxedo/agent-runtime-contract"
import { selectedProviderProjection, type PluginProjection, type ResolvedCredentials } from "../../contract"
import { CredentialSelectionError } from "../../registry/credentials"
import { CLAXEDO_MARKETPLACE, codexHomeKey, codexStoreKey, codexMirror, linkConversationStore, mirrorOwnerCodexHome } from "./home"
import { mirrorConfigTree } from "../config-mirror"

const START = "# BEGIN CLAXEDO CODEX PROFILE"
const END = "# END CLAXEDO CODEX PROFILE"

export const CODEX_BROKER_PROVIDER = "broker"
export const CODEX_DEFAULT_PROVIDER = "openai"

export type CodexProfile = { home: string; store: string; configOverrides: string[]; brokered: boolean; plugins: string[] }

export type CodexProfileInput = {
  homeRoot: string
  credentials: ResolvedCredentials
  projection: PluginProjection
  ownerHome?: string
}

function validatedCodexPluginSegment(name: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") throw new Error(`Invalid Codex plugin name ${name}`)
  return name
}

async function installedPlugins(folder: string): Promise<string[]> {
  return (await fs.readdir(folder).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []
    throw error
  })).sort()
}

async function installCodexPlugin(item: PluginProjection["pluginRoots"][number], source: string, cache: string): Promise<string> {
  const fields = asRecordOrEmpty(JSON.parse(await fs.readFile(path.join(item.root, ".codex-plugin", "plugin.json"), "utf8")))
  const name = validatedCodexPluginSegment(asString(fields.name) ?? "")
  const version = validatedCodexPluginSegment(asString(fields.version) ?? "1.0.0")
  const pluginRoot = await fs.realpath(item.root)
  await mirrorConfigTree(item.root, path.join(source, "plugins", name), pluginRoot, codexMirror)
  await fs.mkdir(path.join(cache, name), { recursive: true, mode: 0o700 })
  await mirrorConfigTree(item.root, path.join(cache, name, version), pluginRoot, codexMirror)
  for (const stale of await fs.readdir(path.join(cache, name))) if (stale !== version) await fs.rm(path.join(cache, name, stale), { recursive: true, force: true })
  return name
}

async function marketplace(home: string, projection: PluginProjection): Promise<{ block: string; plugins: string[] }> {
  const source = path.join(home, "marketplace")
  const cache = path.join(home, "plugins", "cache", CLAXEDO_MARKETPLACE)
  const names = new Set<string>()
  for (const item of projection.pluginRoots) {
    await fs.mkdir(path.join(source, "plugins"), { recursive: true, mode: 0o700 })
    const name = await installCodexPlugin(item, source, cache)
    if (names.has(name)) throw new Error(`Duplicate Codex plugin ${name}`)
    names.add(name)
  }
  const installed = await installedPlugins(path.join(source, "plugins"))
  if (!installed.length) return { block: "", plugins: [] }
  await fs.mkdir(path.join(source, ".agents", "plugins"), { recursive: true, mode: 0o700 })
  await writePrivateFileAtomic(path.join(source, ".agents", "plugins", "marketplace.json"), JSON.stringify({ name: CLAXEDO_MARKETPLACE,
    plugins: installed.map((name) => ({ name, source: { source: "local", path: `./plugins/${name}` } })) }))
  return { block: [`[marketplaces.${CLAXEDO_MARKETPLACE}]`, 'source_type = "local"', `source = ${JSON.stringify(source)}`].join("\n"),
    plugins: [...names].map((name) => `${name}@${CLAXEDO_MARKETPLACE}`) }
}

function brokerFragment(selected: { baseUrl: string; apiPath?: string; placeholder: string }): string {
  return [
    "check_for_update_on_startup = false",
    `model_provider = ${JSON.stringify(CODEX_BROKER_PROVIDER)}`,
    `[model_providers.${CODEX_BROKER_PROVIDER}]`,
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

function personalConfig(content: string, projection: PluginProjection): string {
  const retained = withoutClaxedoBlock(content)
  if (projection.pluginSelection?.mode !== "selected") return retained
  const config = parse(retained)
  delete config.plugins
  delete config.marketplaces
  return stringify(config).trimEnd()
}

function selectedCodexAccount(credentials: ResolvedCredentials) {
  const selected = codexCredential(credentials)
  if (selected && "unavailable" in selected) throw new CredentialSelectionError("account_unavailable", `Codex account unavailable: ${selected.reason}`)
  if (!selected && !credentials.machineLoginAllowed) {
    throw new CredentialSelectionError("account_unavailable", "Codex requires a selected account for this session owner")
  }
  return selected
}

export function codexProfilePaths(input: Omit<CodexProfileInput, "ownerHome">): { store: string; home: string } {
  const selected = selectedCodexAccount(input.credentials)
  const store = path.join(input.homeRoot, codexStoreKey(input.credentials.accountOwner))
  return { store, home: path.join(store, "homes", codexHomeKey(input.credentials.accountOwner, selected, input.projection)) }
}

export function codexOwnerHome(ownerHome?: string): string {
  return ownerHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex")
}

export function codexProbeInputs(credentials: ResolvedCredentials, directory: string, ownerHome?: string): string[] {
  const owner = codexCredential(credentials) ? [] : ["config.toml", "auth.json"].map((name) => path.join(codexOwnerHome(ownerHome), name))
  return [...owner, path.join(path.resolve(directory), ".codex", "config.toml")]
}

export async function prepareCodexProfile(input: CodexProfileInput): Promise<CodexProfile> {
  const selected = selectedCodexAccount(input.credentials)
  const brokered = Boolean(selected)
  const ownerHome = codexOwnerHome(input.ownerHome)
  const { store, home } = codexProfilePaths(input)
  for (const folder of [store, home]) {
    if ((await lstatIfExists(folder))?.isSymbolicLink()) throw new Error("Codex home cannot be a symlink")
    await fs.mkdir(folder, { recursive: true, mode: 0o700 })
    await fs.chmod(folder, 0o700)
  }
  await linkConversationStore(store, home)
  if (!brokered) await mirrorOwnerCodexHome(ownerHome, home, input.projection.pluginSelection?.mode !== "selected")
  const plugins = await marketplace(home, input.projection)
  const fragments = [plugins.block]
  if (selected) fragments.unshift(brokerFragment(selected))
  const retained = brokered ? "" : personalConfig(await readTextIfExists(path.join(ownerHome, "config.toml")) ?? "", input.projection)
  const block = fragments.filter(Boolean).join("\n\n")
  const next = [retained, block ? `${START}\n${block}\n${END}` : ""].filter(Boolean).join("\n\n")
  await writePrivateFileAtomic(path.join(home, "config.toml"), `${next}\n`)
  return { home, store, configOverrides: [`sqlite_home=${JSON.stringify(store)}`], brokered, plugins: plugins.plugins }
}
