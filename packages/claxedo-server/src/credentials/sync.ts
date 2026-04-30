import { loadUserConfig } from "../agent-config"
import { sandbox_provider_ids, type SandboxProviderID } from "../cloud/types"
import { Log } from "../log"
import { getCredentialByProvider, putCredential } from "./registry"
import type { CredentialKind, CredentialSource } from "./types"
import fs from "fs"
import os from "os"
import path from "path"

const log = Log.create({ service: "credentials-sync" })

type Item = {
  provider_id: string
  kind: CredentialKind
  source: CredentialSource
  label: string
  secret: string
}

const acp = {
  "claude-acp": "ANTHROPIC_API_KEY",
  "codex-acp": "OPENAI_API_KEY",
  "cursor-acp": "CURSOR_API_KEY",
} as const

function opencodeAuthPath() {
  return path.join(os.homedir(), ".local", "share", "opencode", "auth.json")
}

function opencodeAuth() {
  try {
    const file = opencodeAuthPath()
    if (!fs.existsSync(file)) return
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>
    return data
  } catch (err) {
    log.warn("Failed to read OpenCode auth", { error: String(err) })
  }
}

function codexAuthPath() {
  return path.join(os.homedir(), ".codex", "auth.json")
}

function codexAccountsPath() {
  return path.join(os.homedir(), ".codex", "accounts")
}

function codexAuth() {
  try {
    const file = codexAuthPath()
    if (!fs.existsSync(file)) return
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>
    return data
  } catch (err) {
    log.warn("Failed to read Codex auth", { error: String(err) })
  }
}

function codexAccountAuth() {
  try {
    const dir = codexAccountsPath()
    if (!fs.existsSync(dir)) return
    const latest = fs.readdirSync(dir)
      .filter((entry) => entry.endsWith(".auth.json"))
      .flatMap((entry) => {
        const file = path.join(dir, entry)
        const data = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>
        const bundle = codexBundle(data)
        if (!bundle) return []
        return [{
          data,
          refreshed: Date.parse(bundle.last_refresh) || 0,
        }]
      })
      .sort((a, b) => b.refreshed - a.refreshed)[0]
    return latest?.data
  } catch (err) {
    log.warn("Failed to read Codex account auth", { error: String(err) })
  }
}

function jwtExp(input: string | undefined) {
  if (!input) return
  try {
    const part = input.split(".")[1]
    if (!part) return
    const base = part
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(part.length / 4) * 4, "=")
    const data = JSON.parse(Buffer.from(base, "base64").toString("utf8")) as { exp?: unknown }
    return typeof data.exp === "number" ? data.exp * 1000 : undefined
  } catch {}
}

function codexBundle(input: unknown) {
  if (!input || typeof input !== "object") return
  const row = input as Record<string, unknown>
  const tokens = row.tokens && typeof row.tokens === "object" ? row.tokens as Record<string, unknown> : undefined
  const access = clean(typeof tokens?.access_token === "string" ? tokens.access_token : undefined)
  const refresh = clean(typeof tokens?.refresh_token === "string" ? tokens.refresh_token : undefined)
  const account_id = clean(typeof tokens?.account_id === "string" ? tokens.account_id : undefined)
  const id_token = clean(typeof tokens?.id_token === "string" ? tokens.id_token : undefined)
  if (!access || !refresh || !account_id) return
  return {
    auth_mode: clean(typeof row.auth_mode === "string" ? row.auth_mode : undefined) ?? "chatgpt",
    OPENAI_API_KEY: clean(typeof row.OPENAI_API_KEY === "string" ? row.OPENAI_API_KEY : undefined) ?? null,
    tokens: {
      ...(id_token ? { id_token } : {}),
      access_token: access,
      refresh_token: refresh,
      account_id,
    },
    last_refresh: clean(typeof row.last_refresh === "string" ? row.last_refresh : undefined) ?? new Date().toISOString(),
  }
}

function opencodeCodex(input: unknown, local: unknown) {
  const row = input && typeof input === "object" ? input as Record<string, unknown> : undefined
  const bundle = codexBundle(local)
  const refresh = clean(typeof row?.refresh === "string" ? row.refresh : undefined) ?? bundle?.tokens.refresh_token
  const access = clean(typeof row?.access === "string" ? row.access : undefined) ?? bundle?.tokens.access_token
  const account_id = clean(typeof row?.accountId === "string" ? row.accountId : undefined) ?? bundle?.tokens.account_id
  const expires =
    typeof row?.expires === "number"
      ? row.expires
      : jwtExp(access) ?? Date.now() + 55 * 60 * 1000
  if (!refresh || !access) return
  return {
    provider_id: "codex-acp",
    kind: "oauth_token" as const,
    source: row?.type === "oauth" ? "upstream_sync" as const : "local_only" as const,
    label: row?.type === "oauth" ? "Synced from OpenCode auth" : "Synced from local Codex auth",
    secret: JSON.stringify({
      source: row?.type === "oauth" ? "opencode" : "codex",
      type: "codex_auth",
      ...(bundle ? bundle : {}),
      refresh,
      access,
      expires,
      account_id,
      enterprise_url: typeof row?.enterpriseUrl === "string" ? row.enterpriseUrl : undefined,
      oauth: {
        refresh,
        access,
        expires,
        ...(account_id ? { account_id } : {}),
        ...(typeof row?.enterpriseUrl === "string" ? { enterprise_url: row.enterpriseUrl } : {}),
      },
    }),
  }
}

function opencodeOpenAI(input: unknown) {
  if (!input || typeof input !== "object") return
  const row = input as Record<string, unknown>
  if (row.type === "api") {
    const key = clean(typeof row.key === "string" ? row.key : undefined)
    if (!key) return
    return {
      provider_id: "openai",
      kind: "api_key" as const,
      source: "upstream_sync" as const,
      label: "Synced from OpenCode auth",
      secret: key,
    }
  }
  if (row.type !== "oauth") return
  const refresh = clean(typeof row.refresh === "string" ? row.refresh : undefined)
  const access = clean(typeof row.access === "string" ? row.access : undefined)
  const expires = typeof row.expires === "number" ? row.expires : undefined
  if (!refresh || !access || !expires) return
  return {
    provider_id: "openai",
    kind: "oauth_token" as const,
    source: "upstream_sync" as const,
    label: "Synced from OpenCode auth",
    secret: JSON.stringify({
      type: "oauth",
      refresh,
      access,
      expires,
      ...(typeof row.accountId === "string" ? { accountId: row.accountId } : {}),
      ...(typeof row.enterpriseUrl === "string" ? { enterpriseUrl: row.enterpriseUrl } : {}),
    }),
  }
}

function opencodeCopilot(input: unknown, provider_id: "github-copilot" | "github-copilot-enterprise") {
  if (!input || typeof input !== "object") return
  const row = input as Record<string, unknown>
  if (row.type !== "oauth") return
  const refresh = clean(typeof row.refresh === "string" ? row.refresh : undefined)
  const access = clean(typeof row.access === "string" ? row.access : undefined)
  if (!refresh || !access) return
  return {
    provider_id,
    kind: "oauth_token" as const,
    source: "upstream_sync" as const,
    label: "Synced from OpenCode auth",
    secret: JSON.stringify({
      source: "opencode",
      type: "copilot_oauth",
      refresh,
      access,
      expires: typeof row.expires === "number" ? row.expires : undefined,
      account_id: typeof row.accountId === "string" ? row.accountId : undefined,
      enterprise_url: typeof row.enterpriseUrl === "string" ? row.enterpriseUrl : undefined,
    }),
  }
}

function clean(input: string | undefined) {
  const txt = input?.trim()
  return txt ? txt : undefined
}

function kind(provider_id: string): CredentialKind {
  return (sandbox_provider_ids as readonly string[]).includes(provider_id) ? "sandbox_provider" : "api_key"
}

function put(map: Map<string, Item>, item: Item | undefined) {
  if (!item) return
  map.set(item.provider_id, item)
}

function sandboxItem(provider_id: SandboxProviderID, source: CredentialSource, label: string, secret: string | undefined) {
  const txt = clean(secret)
  if (!txt) return
  return {
    provider_id,
    kind: "sandbox_provider" as const,
    source,
    label,
    secret: txt,
  }
}

export async function collectLocalCredentials() {
  const cfg = await loadUserConfig()
  const map = new Map<string, Item>()
  const opencode = opencodeAuth()
  const codex = codexAccountAuth() ?? codexAuth()

  put(map, opencodeOpenAI(opencode?.openai))
  put(map, opencodeCodex(opencode?.openai, codex))
  put(map, opencodeCopilot(opencode?.["github-copilot"], "github-copilot"))
  put(map, opencodeCopilot(opencode?.["github-copilot-enterprise"], "github-copilot-enterprise"))

  for (const [provider_id, secret] of Object.entries(cfg.auth ?? {})) {
    const txt = clean(secret)
    if (!txt) continue
    put(map, {
      provider_id,
      kind: kind(provider_id),
      source: "local_only",
      label: "Synced from local config",
      secret: txt,
    })
  }

  put(
    map,
    sandboxItem(
      "daytona",
      "local_only",
      "Synced from local sandbox config",
      cfg.sandbox?.auth?.daytona?.api_key,
    ),
  )
  put(
    map,
    cfg.sandbox?.auth?.modal?.token_id && cfg.sandbox?.auth?.modal?.token_secret
      ? {
          provider_id: "modal",
          kind: "sandbox_provider",
          source: "local_only",
          label: "Synced from local sandbox config",
          secret: JSON.stringify({
            token_id: cfg.sandbox.auth.modal.token_id,
            token_secret: cfg.sandbox.auth.modal.token_secret,
          }),
        }
      : undefined,
  )
  put(
    map,
    sandboxItem(
      "vercel",
      "local_only",
      "Synced from local sandbox config",
      cfg.sandbox?.auth?.vercel?.access_token,
    ),
  )
  put(
    map,
    cfg.sandbox?.auth?.cloudflare?.api_token && cfg.sandbox?.auth?.cloudflare?.worker_url
      ? {
          provider_id: "cloudflare",
          kind: "sandbox_provider",
          source: "local_only",
          label: "Synced from local sandbox config",
          secret: JSON.stringify({
            api_token: cfg.sandbox.auth.cloudflare.api_token,
            worker_url: cfg.sandbox.auth.cloudflare.worker_url,
          }),
        }
      : undefined,
  )

  for (const [provider_id, name] of Object.entries(acp)) {
    const secret = clean(process.env[name])
    if (!secret) continue
    put(map, {
      provider_id,
      kind: "api_key",
      source: "env",
      label: `Synced from ${name}`,
      secret,
    })
  }

  put(
    map,
    sandboxItem("daytona", "env", "Synced from DAYTONA_API_KEY", process.env.DAYTONA_API_KEY),
  )
  put(
    map,
    clean(process.env.MODAL_TOKEN_ID) && clean(process.env.MODAL_TOKEN_SECRET)
      ? {
          provider_id: "modal",
          kind: "sandbox_provider",
          source: "env",
          label: "Synced from MODAL_TOKEN_ID/MODAL_TOKEN_SECRET",
          secret: JSON.stringify({
            token_id: process.env.MODAL_TOKEN_ID!.trim(),
            token_secret: process.env.MODAL_TOKEN_SECRET!.trim(),
          }),
        }
      : undefined,
  )
  put(
    map,
    sandboxItem(
      "vercel",
      "env",
      clean(process.env.VERCEL_TOKEN) ? "Synced from VERCEL_TOKEN" : "Synced from VERCEL_OIDC_TOKEN",
      process.env.VERCEL_TOKEN ?? process.env.VERCEL_OIDC_TOKEN,
    ),
  )
  put(
    map,
    clean(process.env.CLOUDFLARE_API_TOKEN) && clean(process.env.CLOUDFLARE_SANDBOX_WORKER_URL)
      ? {
          provider_id: "cloudflare",
          kind: "sandbox_provider",
          source: "env",
          label: "Synced from CLOUDFLARE_API_TOKEN/CLOUDFLARE_SANDBOX_WORKER_URL",
          secret: JSON.stringify({
            api_token: process.env.CLOUDFLARE_API_TOKEN!.trim(),
            worker_url: process.env.CLOUDFLARE_SANDBOX_WORKER_URL!.trim(),
          }),
        }
      : undefined,
  )

  return map
}

export async function syncLocalCredentials(ids?: string[]) {
  const all = await collectLocalCredentials()
  const list = ids?.length ? [...new Set(ids)] : [...all.keys()]
  const synced: string[] = []
  const existing: string[] = []
  const missing: string[] = []
  const failed: Array<{ provider_id: string; error: string }> = []

  for (const provider_id of list) {
    const current = getCredentialByProvider(provider_id)
    if (current?.source === "managed") {
      existing.push(provider_id)
      continue
    }
    const item = all.get(provider_id)
    if (!item) {
      if (current) {
        existing.push(provider_id)
        continue
      }
      missing.push(provider_id)
      continue
    }
    try {
      await putCredential(item)
      synced.push(provider_id)
    } catch (err) {
      failed.push({
        provider_id,
        error: err instanceof Error ? err.message : String(err),
      })
      log.error("Failed to sync local credential", { provider_id, error: String(err) })
    }
  }

  return { synced, existing, missing, failed }
}
