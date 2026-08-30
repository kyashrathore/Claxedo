import { OPENAI_CLIENT_ID, OPENAI_TOKEN_URL } from "../provider-auth/openai-oauth"
import type { CredentialMetadata } from "@claxedo/server-core/credentials/types"

/**
 * Non-interactive refresh for imported OAuth credentials.
 *
 * A Codex login on disk (`~/.codex/auth.json`, `~/.codex/accounts/*.auth.json`)
 * carries an access token *and* a refresh token; the CLI refreshes the pair
 * transparently on use, so an access token that expired hours ago says nothing
 * about whether the subscription works. `credentials/sync.ts` stores both but
 * derives `expires_at` from the **access** token's JWT `exp`, which used to make
 * `verifyCredential` declare every imported-and-idle Codex login permanently
 * `expired` without ever contacting the provider.
 *
 * Request shape matches the two existing implementations in this repo —
 * `agent-sdk-runtime/src/harnesses/codex/driver.ts` and
 * `core/src/plugin/provider/openai.ts` — form-encoded, no client secret.
 */

export class CredentialRefreshError extends Error {}

export type RefreshedCredentialSecret = {
  secret: string
  expiresAt: number
}

/** Providers whose stored secret can be renewed without the user present. */
const refreshableProviders = ["openai", "codex-app-server"]

/** Access tokens are minted ~1h; mirrors the same fallback `sync.ts` uses. */
const fallbackLifetimeMs = 55 * 60 * 1000

export function isRefreshableCredential(credential: CredentialMetadata) {
  return credential.kind === "oauth_token" && refreshableProviders.includes(credential.provider_id)
}

/**
 * Pull the refresh token out of a stored secret. The collector writes the same
 * value into several mirrored places depending on where the login came from, so
 * read every known shape rather than assuming one.
 */
export function credentialRefreshToken(secret: string) {
  const value = jsonRecord(secret)
  if (!value) return
  const tokens = record(value.tokens)
  const oauth = record(value.oauth)
  return [value.refresh, value.refresh_token, tokens?.refresh_token, oauth?.refresh, oauth?.refresh_token].find(
    (item): item is string => typeof item === "string" && item.length > 0,
  )
}

export async function refreshCredentialSecret(
  credential: CredentialMetadata,
  secret: string,
  options: { fetch?: typeof fetch; now?: () => number } = {},
): Promise<RefreshedCredentialSecret> {
  if (!isRefreshableCredential(credential)) {
    throw new CredentialRefreshError("Credential provider does not support refresh")
  }
  const current = credentialRefreshToken(secret)
  if (!current) throw new CredentialRefreshError("Credential secret has no refresh token")

  const response = await (options.fetch ?? globalThis.fetch)(OPENAI_TOKEN_URL, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: current,
      client_id: OPENAI_CLIENT_ID,
    }).toString(),
  }).catch(() => {
    throw new CredentialRefreshError("Credential refresh request failed")
  })

  if (!response.ok) {
    // OAuth error codes (`invalid_grant`, `invalid_client`, …) are not secret
    // and are the only thing that distinguishes "revoked" from "misconfigured".
    const reason = await response.text().then(oauthErrorCode).catch(() => undefined)
    throw new CredentialRefreshError(
      `Credential refresh was rejected (${response.status}${reason ? `: ${reason}` : ""})`,
    )
  }

  const body = record(await response.json().catch(() => undefined))
  const access = text(body?.access_token)
  if (!access) throw new CredentialRefreshError("Credential refresh returned no access token")
  // The provider may or may not rotate the refresh token; keep the current one
  // when it does not, or the next refresh has nothing to present.
  const refresh = text(body?.refresh_token) ?? current
  const idToken = text(body?.id_token)
  const now = options.now ?? Date.now
  const expiresAt = jwtExpiry(access) ?? now() + fallbackLifetimeMs

  return {
    secret: rewriteSecret(secret, { access, refresh, idToken, expiresAt, now }),
    expiresAt,
  }
}

/**
 * Write the new tokens back into every mirrored position the secret already
 * uses, and only those — consumers read different ones (`central-session-runtime`
 * reads `tokens.refresh_token`, the OpenCode-shaped secret reads `oauth.access`),
 * so inventing keys that were not there would change the secret's shape.
 */
function rewriteSecret(
  secret: string,
  next: { access: string; refresh: string; idToken?: string; expiresAt: number; now: () => number },
) {
  const value = jsonRecord(secret)
  if (!value) throw new CredentialRefreshError("Credential secret has an unsupported shape")
  const updated: Record<string, unknown> = { ...value }

  if ("access" in updated) updated.access = next.access
  if ("access_token" in updated) updated.access_token = next.access
  if ("refresh" in updated) updated.refresh = next.refresh
  if ("refresh_token" in updated) updated.refresh_token = next.refresh
  if ("expires" in updated) updated.expires = next.expiresAt
  if ("last_refresh" in updated) updated.last_refresh = new Date(next.now()).toISOString()

  const tokens = record(value.tokens)
  if (tokens) {
    updated.tokens = {
      ...tokens,
      access_token: next.access,
      refresh_token: next.refresh,
      ...(next.idToken && "id_token" in tokens ? { id_token: next.idToken } : {}),
    }
  }

  const oauth = record(value.oauth)
  if (oauth) {
    updated.oauth = {
      ...oauth,
      ...("access" in oauth ? { access: next.access } : {}),
      ...("access_token" in oauth ? { access_token: next.access } : {}),
      ...("refresh" in oauth ? { refresh: next.refresh } : {}),
      ...("refresh_token" in oauth ? { refresh_token: next.refresh } : {}),
      ...("expires" in oauth ? { expires: next.expiresAt } : {}),
    }
  }

  return JSON.stringify(updated)
}

function oauthErrorCode(body: string) {
  const value = jsonRecord(body)
  const code = text(value?.error) ?? text(value?.error_description)
  return code?.slice(0, 120)
}

function jwtExpiry(token: string) {
  const base = token.split(".")[1]
  if (!base) return
  try {
    const claims = JSON.parse(Buffer.from(base, "base64url").toString("utf8")) as { exp?: unknown }
    return typeof claims.exp === "number" ? claims.exp * 1000 : undefined
  } catch {
    return
  }
}

function text(input: unknown) {
  return typeof input === "string" && input.length > 0 ? input : undefined
}

function jsonRecord(input: string) {
  try {
    return record(JSON.parse(input) as unknown)
  } catch {
    return
  }
}

function record(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return
  return input as Record<string, unknown>
}
