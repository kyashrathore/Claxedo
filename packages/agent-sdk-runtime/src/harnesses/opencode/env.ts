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
  const openai = authEntry(auth?.openai ?? auth?.["codex-acp"])
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
  if (!value) {
    const key = input?.trim()
    if (!key) return
    return { type: "api" as const, key }
  }
  if (value.type === "api" && typeof value.key === "string") {
    return { type: "api" as const, key: value.key }
  }
  if (
    value.type === "oauth"
    && typeof value.refresh === "string"
    && typeof value.access === "string"
    && typeof value.expires === "number"
  ) {
    return {
      type: "oauth" as const,
      refresh: value.refresh,
      access: value.access,
      expires: value.expires,
      ...(typeof value.accountId === "string" ? { accountId: value.accountId } : {}),
      ...(typeof value.enterpriseUrl === "string" ? { enterpriseUrl: value.enterpriseUrl } : {}),
    }
  }
  if (value.type !== "codex_auth") return
  const refresh =
    typeof value.refresh === "string"
      ? value.refresh
      : value.oauth && typeof value.oauth === "object" && typeof (value.oauth as Record<string, unknown>).refresh === "string"
        ? (value.oauth as Record<string, unknown>).refresh as string
        : undefined
  const access =
    typeof value.access === "string"
      ? value.access
      : value.oauth && typeof value.oauth === "object" && typeof (value.oauth as Record<string, unknown>).access === "string"
        ? (value.oauth as Record<string, unknown>).access as string
        : undefined
  const expires =
    typeof value.expires === "number"
      ? value.expires
      : value.oauth && typeof value.oauth === "object" && typeof (value.oauth as Record<string, unknown>).expires === "number"
        ? (value.oauth as Record<string, unknown>).expires as number
        : undefined
  if (typeof value.OPENAI_API_KEY === "string" && value.OPENAI_API_KEY) {
    return { type: "api" as const, key: value.OPENAI_API_KEY }
  }
  if (!refresh || !access || !expires) return
  return {
    type: "oauth" as const,
    refresh,
    access,
    expires,
    ...(typeof value.account_id === "string" ? { accountId: value.account_id } : {}),
    ...(value.oauth && typeof value.oauth === "object" && typeof (value.oauth as Record<string, unknown>).account_id === "string"
      ? { accountId: (value.oauth as Record<string, unknown>).account_id as string }
      : {}),
    ...(typeof value.enterprise_url === "string" ? { enterpriseUrl: value.enterprise_url } : {}),
    ...(value.oauth && typeof value.oauth === "object" && typeof (value.oauth as Record<string, unknown>).enterprise_url === "string"
      ? { enterpriseUrl: (value.oauth as Record<string, unknown>).enterprise_url as string }
      : {}),
  }
}
