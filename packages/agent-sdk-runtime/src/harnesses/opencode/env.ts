import fs from "fs/promises"
import path from "path"
import { dataDir } from "../../paths"
import { harnessSpawnEnv } from "../shared/spawn-env"

const OPENCODE_CONFIG_DIR = path.join(dataDir(), "opencode-config")
const OPENCODE_XDG_CONFIG_HOME = path.join(dataDir(), "opencode-xdg-config")
const OPENCODE_XDG_DATA_HOME = path.join(dataDir(), "opencode-xdg-data")
const OPENCODE_XDG_CACHE_HOME = path.join(dataDir(), "opencode-xdg-cache")

export function spawnEnv(base = process.env) {
  return harnessSpawnEnv({
    ...base,
    OPENCODE_CONFIG_DIR: base.OPENCODE_CONFIG_DIR ?? OPENCODE_CONFIG_DIR,
    XDG_CONFIG_HOME: base.XDG_CONFIG_HOME ?? OPENCODE_XDG_CONFIG_HOME,
    XDG_DATA_HOME: base.XDG_DATA_HOME ?? OPENCODE_XDG_DATA_HOME,
    XDG_CACHE_HOME: base.XDG_CACHE_HOME ?? OPENCODE_XDG_CACHE_HOME,
  })
}

export async function prepareSpawnEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined>) {
  await Promise.all([
    fs.mkdir(env.OPENCODE_CONFIG_DIR ?? OPENCODE_CONFIG_DIR, { recursive: true }),
    fs.mkdir(env.XDG_CONFIG_HOME ?? OPENCODE_XDG_CONFIG_HOME, { recursive: true }),
    fs.mkdir(env.XDG_DATA_HOME ?? OPENCODE_XDG_DATA_HOME, { recursive: true }),
    fs.mkdir(env.XDG_CACHE_HOME ?? OPENCODE_XDG_CACHE_HOME, { recursive: true }),
  ])
}

export function opencodeAuthContent(auth: Record<string, string> | undefined) {
  const openai = authEntry(auth?.openai)
  if (!openai) return
  return JSON.stringify({ openai })
}

function json(input: string | undefined) {
  if (!input) return
  try {
    const value = JSON.parse(input) as Record<string, unknown>
    return value && typeof value === "object" ? value : undefined
  } catch {}
}

function authEntry(input: string | undefined) {
  const value = json(input)
  if (!value) return apiEntry(input?.trim())
  if (value.type === "api") return apiEntry(stringValue(value.key))
  if (value.type === "oauth") return oauthEntry(value)
  if (value.type !== "codex_auth") return
  return codexAuthEntry(value)
}

function apiEntry(key: string | undefined) {
  return key ? { type: "api" as const, key } : undefined
}

function oauthEntry(value: Record<string, unknown>) {
  const refresh = stringValue(value.refresh)
  const access = stringValue(value.access)
  const expires = numberValue(value.expires)
  if (!refresh || !access || expires === undefined) return
  return {
    type: "oauth" as const,
    refresh,
    access,
    expires,
    ...(stringValue(value.accountId) ? { accountId: stringValue(value.accountId) } : {}),
    ...(stringValue(value.enterpriseUrl) ? { enterpriseUrl: stringValue(value.enterpriseUrl) } : {}),
  }
}

function codexAuthEntry(value: Record<string, unknown>) {
  const oauth = objectValue(value.oauth)
  const apiKey = stringValue(value.OPENAI_API_KEY)
  if (apiKey) return apiEntry(apiKey)
  const refresh = stringValue(value.refresh) ?? stringValue(oauth?.refresh)
  const access = stringValue(value.access) ?? stringValue(oauth?.access)
  const expires = numberValue(value.expires) ?? numberValue(oauth?.expires)
  if (!refresh || !access || expires === undefined) return
  const accountId = stringValue(value.account_id) ?? stringValue(oauth?.account_id)
  const enterpriseUrl = stringValue(value.enterprise_url) ?? stringValue(oauth?.enterprise_url)
  return {
    type: "oauth" as const,
    refresh,
    access,
    expires,
    ...(accountId ? { accountId } : {}),
    ...(enterpriseUrl ? { enterpriseUrl } : {}),
  }
}

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function numberValue(value: unknown) {
  return typeof value === "number" ? value : undefined
}
