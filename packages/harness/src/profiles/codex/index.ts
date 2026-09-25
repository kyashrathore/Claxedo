import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { asRecordOrEmpty, asString } from "@claxedo/helpers/guards"
import type { PluginProjection, ResolvedCredentials } from "../../contract"

const MARKETPLACE = "claxedo-agent-plugins"
const START = "# BEGIN CLAXEDO CODEX PROFILE"
const END = "# END CLAXEDO CODEX PROFILE"

export type CodexProfile = { home: string; brokered: boolean }

function validatedCodexPluginSegment(name: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") throw new Error(`Invalid Codex plugin name ${name}`)
  return name
}

async function marketplace(home: string, projection: PluginProjection): Promise<string> {
  if (!projection.pluginRoots.length) return ""
  const source = path.join(home, "marketplace")
  const manifest = path.join(source, ".agents", "plugins")
  const cache = path.join(home, "plugins", "cache", MARKETPLACE)
  await fs.mkdir(manifest, { recursive: true, mode: 0o700 })
  await fs.mkdir(cache, { recursive: true, mode: 0o700 })
  const names = new Set<string>()
  const plugins = []
  for (const item of projection.pluginRoots) {
    const manifestFile = path.join(item.root, ".codex-plugin", "plugin.json")
    const manifest: unknown = JSON.parse(await fs.readFile(manifestFile, "utf8"))
    const fields = asRecordOrEmpty(manifest)
    const name = validatedCodexPluginSegment(asString(fields.name) ?? "")
    const version = validatedCodexPluginSegment(asString(fields.version) ?? "1.0.0")
    if (names.has(name)) throw new Error(`Duplicate Codex plugin ${name}`)
    names.add(name)
    const pluginSource = path.join(source, "plugins", name)
    await fs.mkdir(path.dirname(pluginSource), { recursive: true, mode: 0o700 })
    await fs.cp(item.root, pluginSource, { recursive: true, force: true, dereference: true })
    const destination = path.join(cache, name, version)
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
    await fs.cp(item.root, destination, { recursive: true, force: true, dereference: true })
    plugins.push({ name, source: { source: "local", path: `./plugins/${name}` } })
  }
  await fs.writeFile(path.join(manifest, "marketplace.json"), JSON.stringify({ name: MARKETPLACE, plugins }), { mode: 0o600 })
  return [
    `[marketplaces.${MARKETPLACE}]`,
    'source_type = "local"',
    `source = ${JSON.stringify(source)}`,
    ...plugins.flatMap(({ name }) => [`[plugins.${JSON.stringify(`${name}@${MARKETPLACE}`)}]`, "enabled = true"]),
  ].join("\n")
}

export async function prepareCodexProfile(input: {
  home: string
  credentials: ResolvedCredentials
  projection: PluginProjection
  ownerHome?: string
}): Promise<CodexProfile> {
  const selected = input.credentials.providers.codex
  if (selected && "unavailable" in selected) throw new Error(`Codex account unavailable: ${selected.reason}`)
  const brokered = Boolean(selected)
  const home = brokered ? input.home : input.ownerHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex")
  if (!brokered && input.projection.pluginRoots.length === 0) return { home, brokered }
  const existing = await fs.lstat(home).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (existing?.isSymbolicLink()) throw new Error("Codex home cannot be a symlink")
  await fs.mkdir(home, { recursive: true, mode: 0o700 })
  if (brokered) await fs.chmod(home, 0o700)
  const fragments = [await marketplace(home, input.projection)]
  if (selected && !("unavailable" in selected)) fragments.unshift([
    "check_for_update_on_startup = false",
    'model_provider = "broker"',
    "[model_providers.broker]",
    'name = "Claxedo credential broker"',
    `base_url = ${JSON.stringify(`${selected.baseUrl}${selected.apiPath ?? ""}`)}`,
    'wire_api = "responses"',
    "requires_openai_auth = false",
    `http_headers = { Authorization = ${JSON.stringify(`Bearer ${selected.placeholder}`)} }`,
  ].join("\n"))
  const target = path.join(home, "config.toml")
  const current = brokered ? "" : await fs.readFile(target, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return ""
    throw error
  })
  const begin = current.indexOf(START)
  const end = current.indexOf(END)
  if ((begin === -1) !== (end === -1) || (begin >= 0 && end < begin)) throw new Error("Codex profile block is damaged")
  const retained = begin < 0 ? current.trimEnd() : `${current.slice(0, begin)}${current.slice(end + END.length)}`.trim()
  const block = fragments.filter(Boolean).join("\n\n")
  const next = [retained, block ? `${START}\n${block}\n${END}` : ""].filter(Boolean).join("\n\n")
  const temp = path.join(home, `.config-${crypto.randomUUID()}.tmp`)
  await fs.writeFile(temp, `${next}\n`, { mode: 0o600 })
  await fs.rename(temp, target)
  return { home, brokered }
}
