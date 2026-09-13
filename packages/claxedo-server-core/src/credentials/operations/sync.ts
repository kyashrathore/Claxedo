import { loadUserConfig, sandboxDriverConfig } from "../../agent-config"
import { isSandboxDriverID, type SandboxDriverID } from "@claxedo/sandbox-contract"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import { getCredentialByProvider, putCredential } from "@claxedo/server-core/credentials/registry"
import type { CredentialKind, CredentialSource } from "@claxedo/server-core/credentials/types"
import { trimToUndefined } from "@claxedo/helpers/string"

const log = Log.create({ service: "credentials-sync" })

export type LocalCredentialItem = {
  provider_id: string
  kind: CredentialKind
  source: CredentialSource
  label: string
  origin: string
  secret: string
}

type Item = Omit<LocalCredentialItem, "origin"> & { origin?: string }

/** The harness bindings whose auth an operator can hand us through the environment. */
const nativeHarnessEnv = {
  "claude-sdk": "ANTHROPIC_API_KEY",
  "codex-app-server": "OPENAI_API_KEY",
  "cursor-sdk": "CURSOR_API_KEY",
} as const

function kind(providerId: string): CredentialKind {
  return isSandboxDriverID(providerId) ? "sandbox_driver" : "api_key"
}

function itemOrigin(item: Item) {
  if (item.origin) return item.origin
  if (item.label.includes("local config")) return "Claxedo local config"
  const env = /^Synced from (.+)$/.exec(item.label)?.[1]
  return env ?? item.source
}

/**
 * What makes two collected candidates the same credential. A provider can be
 * handed to us twice in different shapes — a pasted `claude-sdk` key in the
 * agent config and a `CLAUDE_CODE_OAUTH_TOKEN` subscription in the environment
 * — and those are two accounts to choose between, not one row read twice.
 */
export function localCredentialKey(item: { provider_id: string; kind: CredentialKind }) {
  return `${item.provider_id}\u0000${item.kind}`
}

function put(map: Map<string, LocalCredentialItem>, item: Item | undefined) {
  if (!item) return
  const normalized = { ...item, origin: itemOrigin(item) }
  map.set(localCredentialKey(item), normalized)
}

/**
 * A Claude subscription token the operator put in the environment.
 *
 * This is material handed to us on purpose, not the login Claude Code holds on
 * this machine — that one is never copied, and `machine-login.ts` asks the CLI
 * about it instead.
 */
function claudeEnvOAuthItem() {
  const envVar = trimToUndefined(process.env.CLAUDE_CODE_OAUTH_TOKEN)
    ? "CLAUDE_CODE_OAUTH_TOKEN"
    : trimToUndefined(process.env.ANTHROPIC_AUTH_TOKEN)
      ? "ANTHROPIC_AUTH_TOKEN"
      : undefined
  const accessToken = envVar ? trimToUndefined(process.env[envVar]) : undefined
  if (!envVar || !accessToken) return undefined
  return {
    provider_id: "claude-sdk",
    kind: "oauth_token" as const,
    source: "env" as const,
    label: `Synced from ${envVar}`,
    origin: `Environment variable ${envVar}`,
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
  const txt = trimToUndefined(secret)
  if (!txt) return undefined
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
  const access_token = trimToUndefined(input.access_token)
  const team_id = trimToUndefined(input.team_id)
  const project_id = trimToUndefined(input.project_id)
  if (!access_token || !team_id || !project_id) return undefined
  return {
    provider_id: "vercel",
    kind: "sandbox_driver" as const,
    source,
    label,
    secret: JSON.stringify({ access_token, team_id, project_id }),
  }
}

/**
 * The user's agent config, or nothing when it cannot be read.
 *
 * `loadUserConfig` throws on an unreadable file, invalid JSON or a schema it
 * does not recognise. Letting that escape makes one bad file blank the whole
 * scan — the environment-supplied keys beside it have nothing to do with it.
 */
async function userConfigOrNone() {
  try {
    return await loadUserConfig()
  } catch (err) {
    log.warn("Failed to read user agent config while collecting credentials", { error: String(err) })
    return undefined
  }
}

/**
 * Every credential this machine has handed Claxedo on purpose: keys in the
 * user's agent config, sandbox driver settings, and provider secrets in the
 * environment.
 *
 * Not the CLI logins. A harness's own login is asked about, never copied
 * (`credentials/machine-login.ts`), so nothing here opens the Keychain,
 * `~/.claude/.credentials.json` or `~/.codex/auth.json`.
 */
export async function collectLocalCredentials() {
  const cfg = await userConfigOrNone()
  const sandboxDriverConfigValue = sandboxDriverConfig(cfg)
  const map = new Map<string, LocalCredentialItem>()
  put(map, claudeEnvOAuthItem())

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

  for (const [providerId, name] of Object.entries(nativeHarnessEnv)) {
    const secret = trimToUndefined(process.env[name])
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
    trimToUndefined(process.env.MODAL_TOKEN_ID) && trimToUndefined(process.env.MODAL_TOKEN_SECRET)
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
      trimToUndefined(process.env.VERCEL_TOKEN) ? "Synced from VERCEL_TOKEN" : "Synced from VERCEL_OIDC_TOKEN",
      {
        access_token: process.env.VERCEL_TOKEN ?? process.env.VERCEL_OIDC_TOKEN,
        team_id: process.env.VERCEL_TEAM_ID,
        project_id: process.env.VERCEL_PROJECT_ID,
      },
    ),
  )
  put(
    map,
    trimToUndefined(process.env.CLOUDFLARE_API_TOKEN) && trimToUndefined(process.env.CLOUDFLARE_SANDBOX_WORKER_URL)
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

export async function collectLocalCredentialItems() {
  return [...(await collectLocalCredentials()).values()]
}

/**
 * Import locally discovered CLI logins into the registry for ONE org.
 *
 * `org` defaults to the named single-tenant partition — the same fail-closed
 * default the registry uses. It is never a wildcard: an unscoped call reads and
 * writes `__local__` only, so it can neither observe nor clobber another
 * tenant's provider credentials.
 */
export async function syncLocalCredentials(ids?: string[], org?: string) {
  log.warn("Deprecated sync-local credential path called; migrate to explicit discovery (automatic discovery, explicit upload)")
  const all = await collectLocalCredentials()
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
      await Promise.all(items.map((item) => putCredential(item, org)))
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
