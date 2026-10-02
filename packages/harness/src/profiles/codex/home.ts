import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import type { ProviderBinding } from "@claxedo/agent-runtime-contract"
import { lstatIfExists } from "@claxedo/helpers/fs"
import type { PluginProjection } from "../../contract"
import { mirrorConfigEntries, pruneMirrorDirectory, replaceAtomically, type ConfigMirrorOptions } from "../config-mirror"

export const CLAXEDO_MARKETPLACE = "claxedo-agent-plugins"
const MIRRORED = ["AGENTS.md", "instructions.md", "hooks.json", "skills", "prompts", "rules", "plugins"] as const
const STORE_DIRECTORIES = ["sessions", "archived_sessions", "thread-writer-locks", "memories"] as const
const STORE_FILES = ["session_index.jsonl"] as const
const SECRET_FILE = /^(?:auth\.json|\.env)$|(?:^|[-_.])(?:credential|credentials|oauth|secret|token|password|keychain)(?:[-_.]|$)/i
const CODEX_WRITTEN: readonly string[] = [path.join("skills", ".system"), path.join("plugins", "cache", CLAXEDO_MARKETPLACE)]

export const codexMirror: ConfigMirrorOptions = { secretFile: SECRET_FILE, externalSkills: true, keep: (relative) => CODEX_WRITTEN.includes(relative) }

function hashedName(prefix: string, parts: readonly string[]): string {
  return `${prefix}-${createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16)}`
}

export function codexStoreKey(accountOwner: string): string {
  return hashedName("codex-owner", [`person:${accountOwner}`])
}

export function codexHomeKey(accountOwner: string, selected: ProviderBinding | undefined, projection: PluginProjection): string {
  const ownerKey = `person:${accountOwner}`
  const credentialKey = selected ? `broker:${selected.baseUrl}:${selected.authMode}` : "own-login"
  return hashedName("codex", [ownerKey, credentialKey, projection.pluginSelection?.mode ?? "default"])
}

async function linkTo(link: string, target: string): Promise<void> {
  const current = await lstatIfExists(link)
  if (current?.isSymbolicLink() && await fs.readlink(link) === target) return
  await replaceAtomically(link, (temporary) => fs.symlink(target, temporary))
}

async function linkOwnerAuth(ownerHome: string, home: string): Promise<void> {
  const target = path.join(home, "auth.json")
  const auth = path.join(ownerHome, "auth.json")
  if (!(await lstatIfExists(auth))) { await fs.rm(target, { force: true }); return }
  await linkTo(target, auth)
}

export async function linkConversationStore(store: string, home: string): Promise<void> {
  for (const name of STORE_DIRECTORIES) await fs.mkdir(path.join(store, name), { recursive: true, mode: 0o700 })
  for (const name of [...STORE_DIRECTORIES, ...STORE_FILES]) await linkTo(path.join(home, name), path.join(store, name))
}

export async function mirrorOwnerCodexHome(source: string, home: string, includePersonalPlugins: boolean): Promise<void> {
  const names = MIRRORED.filter((name) => name !== "plugins" || includePersonalPlugins)
  const ownerHome = await mirrorConfigEntries(source, home, names, {
    ...codexMirror, directories: ["plugins", "skills"], allowMissingRoot: true,
  })
  if (!includePersonalPlugins) {
    const plugins = path.join(home, "plugins")
    await pruneMirrorDirectory(plugins, "plugins", ["cache"], codexMirror)
    await pruneMirrorDirectory(path.join(plugins, "cache"), path.join("plugins", "cache"), [], codexMirror)
  }
  await linkOwnerAuth(ownerHome!, home)
}
