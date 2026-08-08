import { cleanString as clean } from "@claxedo/server-core/platform/runtime/lib/strings"
import { loadUserConfig, sandboxDriverConfig } from "../../agent-config"
import { sandboxDriverIds, type SandboxDriverID } from "@claxedo/sandbox-manager/driver-catalog"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import { getCredentialByProvider, putCredential } from "@claxedo/server-core/credentials/registry"
import type { CredentialKind, CredentialSource } from "@claxedo/server-core/credentials/types"
import { execFileSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"

const log = Log.create({ service: "credentials-sync" })

export type LocalCredentialItem = {
  provider_id: string
  kind: CredentialKind
  source: CredentialSource
  label: string
  account_id?: string
  origin: string
  fresh_until?: number
  secret: string
}

type Item = Omit<LocalCredentialItem, "origin"> & { origin?: string }

/**
 * The ONE way this module is allowed to reach a command line.
 *
 * Deliberately narrow: a caller can choose whether the Keychain is read at all,
 * but not how — the spawn options (no stdin, stderr discarded, bounded timeout)
 * are fixed at the call site, and there is no seam through which a write
 * subcommand could be smuggled in.
 */
export type CredentialExec = (file: string, args: string[]) => string

export type CollectLocalCredentialsOptions = {
  /**
   * Whether reading the macOS Keychain is permitted on this call.
   *
   * `security find-generic-password` asks the SecurityAgent for authorization
   * when the item's ACL does not already list the calling binary, and there is
   * no flag that suppresses that dialog — so the only way a background or
   * status path can promise not to interrupt the user is to skip the Keychain
   * entirely and fall through to `~/.claude/.credentials.json`. Off by default:
   * a path that has not thought about it is a path that must not prompt.
   */
  allowKeychainPrompt?: boolean
  exec?: CredentialExec
}

const defaultExec: CredentialExec = (file, args) =>
  execFileSync(file, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2_000,
  })

const acp = {
  "claude-acp": "ANTHROPIC_API_KEY",
  "claude-sdk": "ANTHROPIC_API_KEY",
  "codex-acp": "OPENAI_API_KEY",
  "codex-app-server": "OPENAI_API_KEY",
  // cursor-acp is env-only on purpose: cursor-agent needs a dashboard-issued
  // CURSOR_API_KEY, and the only token on disk (the IDE's state.vscdb entry)
  // is a cursor.com web-session JWT, not a valid API key.
  "cursor-acp": "CURSOR_API_KEY",
} as const

// Mirrors the engine's xdg-basedir resolution (packages/core/src/global.ts):
// XDG_DATA_HOME wins, otherwise ~/.local/share — on Windows too (USERPROFILE,
// never APPDATA). Falls back across candidates so a login made before
// XDG_DATA_HOME was set is still found.
function opencodeAuthPath() {
  const xdg = clean(process.env.XDG_DATA_HOME)
  const candidates = [
    ...(xdg ? [path.join(xdg, "opencode", "auth.json")] : []),
    path.join(homeDir(), ".local", "share", "opencode", "auth.json"),
  ]
  return candidates.find((file) => fs.existsSync(file)) ?? candidates[0]
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
  return path.join(homeDir(), ".codex", "auth.json")
}

function codexAccountsPath() {
  return path.join(homeDir(), ".codex", "accounts")
}

function homeDir() {
  return process.env.HOME ?? os.homedir()
}

function claudeCredentialsPath() {
  return path.join(homeDir(), ".claude", ".credentials.json")
}

function claudeCredentialsFileToken() {
  try {
    const file = claudeCredentialsPath()
    if (!fs.existsSync(file)) return
    return claudeCodeOAuthAccessToken(fs.readFileSync(file, "utf8"))
  } catch (err) {
    log.warn("Failed to read Claude Code credentials file", { error: String(err) })
  }
}

function claudeCodeOAuthToken(options: CollectLocalCredentialsOptions) {
  const env = clean(process.env.CLAUDE_CODE_OAUTH_TOKEN) ?? clean(process.env.ANTHROPIC_AUTH_TOKEN)
  if (env) return claudeCodeOAuthAccessToken(env)
  if (options.allowKeychainPrompt && process.platform === "darwin") {
    try {
      const token = claudeCodeOAuthAccessToken((options.exec ?? defaultExec)("security", [
        "find-generic-password",
        "-s",
        "Claude Code-credentials",
        "-a",
        os.userInfo().username,
        "-w",
      ]))
      if (token) return token
    } catch {}
  }
  return claudeCredentialsFileToken()
}

/**
 * The access token, or nothing.
 *
 * A parsed object is NEVER returned raw. The Claude Code credentials blob also
 * carries an `mcpOAuth` map of unrelated third-party tokens, so falling back to
 * the whole document when `claudeAiOauth.accessToken` is missing would store,
 * and later transmit, credentials belonging to servers Claxedo has no business
 * holding. A plain string that is not JSON is a legitimate env-var token
 * (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN`) and passes through.
 */
function claudeCodeOAuthAccessToken(input: string) {
  const raw = clean(input)
  if (!raw) return
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return raw
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return raw
  const row = parsed as Record<string, unknown>
  const oauth = row.claudeAiOauth && typeof row.claudeAiOauth === "object" && !Array.isArray(row.claudeAiOauth)
    ? row.claudeAiOauth as Record<string, unknown>
    : undefined
  return clean(typeof oauth?.accessToken === "string" ? oauth.accessToken : undefined)
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

function codexAccountAuths() {
  try {
    const dir = codexAccountsPath()
    if (!fs.existsSync(dir)) return []
    return fs.readdirSync(dir)
      .filter((entry) => entry.endsWith(".auth.json"))
      .flatMap((entry) => {
        const file = path.join(dir, entry)
        const data = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>
        const bundle = codexBundle(data)
        if (!bundle) return []
        return [{
          data,
          origin: "~/.codex/accounts/*.auth.json",
          refreshed: Date.parse(bundle.last_refresh) || 0,
        }]
      })
      .sort((a, b) => b.refreshed - a.refreshed)
  } catch (err) {
    log.warn("Failed to read Codex account auth", { error: String(err) })
    return []
  }
}

/**
 * Every Codex login on this machine, newest copy per account.
 *
 * `~/.codex/auth.json` and `~/.codex/accounts/<email>.auth.json` can hold the
 * *same* account with different tokens — the CLI refreshes whichever it is
 * using — so preferring the accounts directory wholesale meant importing a
 * months-old copy while a token refreshed yesterday sat in `auth.json`, and the
 * stale one is usually dead at the provider. Compare `last_refresh` across both
 * sources and keep the freshest per account.
 */
function codexAuthCandidates() {
  const primary = codexAuth()
  const primaryBundle = primary ? codexBundle(primary) : undefined
  const candidates = [
    ...codexAccountAuths(),
    ...(primary
      ? [{
        data: primary,
        origin: "~/.codex/auth.json",
        refreshed: primaryBundle ? Date.parse(primaryBundle.last_refresh) || 0 : 0,
      }]
      : []),
  ]

  const freshest = new Map<string, (typeof candidates)[number]>()
  for (const candidate of candidates) {
    const account = codexBundle(candidate.data)?.tokens.account_id ?? ""
    const current = freshest.get(account)
    if (!current || candidate.refreshed > current.refreshed) freshest.set(account, candidate)
  }
  return [...freshest.values()].sort((a, b) => b.refreshed - a.refreshed)
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
    ...(account_id ? { account_id } : {}),
    ...(expires ? { fresh_until: expires } : {}),
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

function opencodeCopilot(input: unknown, providerId: "github-copilot" | "github-copilot-enterprise") {
  if (!input || typeof input !== "object") return
  const row = input as Record<string, unknown>
  if (row.type !== "oauth") return
  const refresh = clean(typeof row.refresh === "string" ? row.refresh : undefined)
  const access = clean(typeof row.access === "string" ? row.access : undefined)
  if (!refresh || !access) return
  return {
    provider_id: providerId,
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


function kind(providerId: string): CredentialKind {
  return (sandboxDriverIds as readonly string[]).includes(providerId) ? "sandbox_driver" : "api_key"
}

function itemOrigin(item: Item) {
  if (item.origin) return item.origin
  if (item.label.includes("OpenCode")) return "~/.local/share/opencode/auth.json"
  if (item.label.includes("Codex")) return "~/.codex/auth.json"
  if (item.label.includes("Claude Code")) return process.platform === "darwin" ? "macOS Keychain or ~/.claude/.credentials.json" : "~/.claude/.credentials.json"
  if (item.label.includes("local config")) return "Claxedo local config"
  const env = /^Synced from (.+)$/.exec(item.label)?.[1]
  return env ?? item.source
}

function put(map: Map<string, LocalCredentialItem>, item: Item | undefined) {
  if (!item) return
  const normalized = { ...item, origin: itemOrigin(item) }
  map.set(`${item.provider_id}\u0000${item.kind}\u0000${item.account_id ?? ""}`, normalized)
}

/**
 * `claude-acp` and `claude-sdk` are two harness bindings of the SAME underlying
 * credential, so they collect as two rows. If those rows carry the same label
 * and the same origin the user is asked to choose between things they cannot
 * tell apart — name the binding, and name the exact env var when that is where
 * the token came from, so "why are there two?" is answerable from the row.
 */
function claudeOAuthItem(providerId: "claude-acp" | "claude-sdk", token: string | undefined) {
  const accessToken = clean(token)
  if (!accessToken) return
  const envVar = process.env.CLAUDE_CODE_OAUTH_TOKEN
    ? "CLAUDE_CODE_OAUTH_TOKEN"
    : process.env.ANTHROPIC_AUTH_TOKEN
      ? "ANTHROPIC_AUTH_TOKEN"
      : undefined
  const binding = providerId === "claude-acp" ? "ACP adapter" : "agent SDK"
  return {
    provider_id: providerId,
    kind: "oauth_token" as const,
    source: "managed" as const,
    label: envVar
      ? `Claude token from ${envVar} · ${binding}`
      : `Claude Code login · ${binding}`,
    ...(envVar ? { origin: `Environment variable ${envVar}` } : {}),
    secret: JSON.stringify({
      type: "claude_code_oauth",
      claudeAiOauth: { accessToken },
    }),
  }
}

function sandboxDriverCredentialItem(
  driverId: SandboxDriverID,
  source: CredentialSource,
  label: string,
  secret: string | undefined,
) {
  const txt = clean(secret)
  if (!txt) return
  return {
    provider_id: driverId,
    kind: "sandbox_driver" as const,
    source,
    label,
    secret: txt,
  }
}

function vercelSandboxDriverCredentialItem(
  source: CredentialSource,
  label: string,
  input: {
    access_token?: string
    team_id?: string
    project_id?: string
  },
) {
  const access_token = clean(input.access_token)
  const team_id = clean(input.team_id)
  const project_id = clean(input.project_id)
  if (!access_token || !team_id || !project_id) return
  return {
    provider_id: "vercel",
    kind: "sandbox_driver" as const,
    source,
    label,
    secret: JSON.stringify({ access_token, team_id, project_id }),
  }
}

export async function collectLocalCredentials(options: CollectLocalCredentialsOptions = {}) {
  const cfg = await loadUserConfig()
  const sandboxDriverConfigValue = sandboxDriverConfig(cfg)
  const map = new Map<string, LocalCredentialItem>()
  const opencode = opencodeAuth()
  const codexAccounts = codexAuthCandidates()
  const codex = codexAccounts[0]?.data

  put(map, opencodeOpenAI(opencode?.openai))
  const primaryCodex = opencodeCodex(opencode?.openai, codex)
  put(map, primaryCodex && !opencode?.openai && codexAccounts[0]
    ? { ...primaryCodex, origin: codexAccounts[0].origin }
    : primaryCodex)
  for (const account of codexAccounts.slice(1)) {
    const item = opencodeCodex(undefined, account.data)
    put(map, item ? { ...item, origin: account.origin } : undefined)
  }
  put(map, opencodeCopilot(opencode?.["github-copilot"], "github-copilot"))
  put(map, opencodeCopilot(opencode?.["github-copilot-enterprise"], "github-copilot-enterprise"))
  const claudeOAuth = claudeCodeOAuthToken(options)
  put(map, claudeOAuthItem("claude-acp", claudeOAuth))
  put(map, claudeOAuthItem("claude-sdk", claudeOAuth))

  for (const [providerId, secret] of Object.entries(cfg.auth ?? {})) {
    const txt = clean(secret)
    if (!txt) continue
    put(map, {
      provider_id: providerId,
      kind: kind(providerId),
      source: "local_only",
      label: "Synced from local config",
      secret: txt,
    })
  }

  put(
    map,
    sandboxDriverCredentialItem(
      "daytona",
      "local_only",
      "Synced from local sandbox driver config",
      sandboxDriverConfigValue.auth?.daytona?.api_key,
    ),
  )
  put(
    map,
    sandboxDriverConfigValue.auth?.modal?.token_id && sandboxDriverConfigValue.auth?.modal?.token_secret
      ? {
          provider_id: "modal",
          kind: "sandbox_driver",
          source: "local_only",
          label: "Synced from local sandbox driver config",
          secret: JSON.stringify({
            token_id: sandboxDriverConfigValue.auth.modal.token_id,
            token_secret: sandboxDriverConfigValue.auth.modal.token_secret,
          }),
        }
      : undefined,
  )
  put(
    map,
    vercelSandboxDriverCredentialItem(
      "local_only",
      "Synced from local sandbox driver config",
      {
        access_token: sandboxDriverConfigValue.auth?.vercel?.access_token,
        team_id: sandboxDriverConfigValue.auth?.vercel?.team_id,
        project_id: sandboxDriverConfigValue.auth?.vercel?.project_id,
      },
    ),
  )
  put(
    map,
    sandboxDriverConfigValue.auth?.cloudflare?.api_token && sandboxDriverConfigValue.auth?.cloudflare?.worker_url
      ? {
          provider_id: "cloudflare",
          kind: "sandbox_driver",
          source: "local_only",
          label: "Synced from local sandbox driver config",
          secret: JSON.stringify({
            api_token: sandboxDriverConfigValue.auth.cloudflare.api_token,
            worker_url: sandboxDriverConfigValue.auth.cloudflare.worker_url,
          }),
        }
      : undefined,
  )

  for (const [providerId, name] of Object.entries(acp)) {
    const secret = clean(process.env[name])
    if (!secret) continue
    put(map, {
      provider_id: providerId,
      kind: "api_key",
      source: "env",
      label: `Synced from ${name}`,
      secret,
    })
  }

  put(
    map,
    sandboxDriverCredentialItem("daytona", "env", "Synced from DAYTONA_API_KEY", process.env.DAYTONA_API_KEY),
  )
  put(
    map,
    clean(process.env.MODAL_TOKEN_ID) && clean(process.env.MODAL_TOKEN_SECRET)
      ? {
          provider_id: "modal",
          kind: "sandbox_driver",
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
    vercelSandboxDriverCredentialItem(
      "env",
      clean(process.env.VERCEL_TOKEN) ? "Synced from VERCEL_TOKEN" : "Synced from VERCEL_OIDC_TOKEN",
      {
        access_token: process.env.VERCEL_TOKEN ?? process.env.VERCEL_OIDC_TOKEN,
        team_id: process.env.VERCEL_TEAM_ID,
        project_id: process.env.VERCEL_PROJECT_ID,
      },
    ),
  )
  put(
    map,
    clean(process.env.CLOUDFLARE_API_TOKEN) && clean(process.env.CLOUDFLARE_SANDBOX_WORKER_URL)
      ? {
          provider_id: "cloudflare",
          kind: "sandbox_driver",
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

export async function collectLocalCredentialItems(options: CollectLocalCredentialsOptions = {}) {
  return [...(await collectLocalCredentials(options)).values()]
}

/**
 * Import locally discovered CLI logins into the registry for ONE org.
 *
 * `org` defaults to the named single-tenant partition — the same fail-closed
 * default the registry uses. It is never a wildcard: an unscoped call reads and
 * writes `__local__` only, so it can neither observe nor clobber another
 * tenant's provider credentials.
 */
export async function syncLocalCredentials(
  ids?: string[],
  org?: string,
  options: CollectLocalCredentialsOptions = {},
) {
  log.warn("Deprecated sync-local credential path called; migrate to explicit discovery (automatic discovery, explicit upload)")
  const all = await collectLocalCredentials(options)
  const list = ids?.length ? [...new Set(ids)] : [...new Set([...all.values()].map((item) => item.provider_id))]
  const synced: string[] = []
  const existing: string[] = []
  const missing: string[] = []
  const failed: Array<{ provider_id: string; error: string }> = []

  for (const providerId of list) {
    const current = getCredentialByProvider(providerId, undefined, org)
    if (current?.source === "managed") {
      existing.push(providerId)
      continue
    }
    const items = [...all.values()].filter((item) => item.provider_id === providerId)
    if (items.length === 0) {
      if (current) {
        existing.push(providerId)
        continue
      }
      missing.push(providerId)
      continue
    }
    try {
      // Carry the collected token expiry through, the same way the discovery
      // path does. Without it an imported OAuth login is stored with no
      // `expires_at`, so nothing downstream can tell a fresh account from a
      // months-old one when a provider has several.
      await Promise.all(items.map((item) => putCredential({
        ...item,
        ...(item.fresh_until ? { expires_at: item.fresh_until } : {}),
      }, org)))
      synced.push(providerId)
    } catch (err) {
      failed.push({
        provider_id: providerId,
        error: err instanceof Error ? err.message : String(err),
      })
      log.error("Failed to sync local credential", { provider_id: providerId, error: String(err) })
    }
  }

  return { synced, existing, missing, failed }
}
