import { jsonRecord, jsonString, parseJsonRecord } from "@claxedo/server-core/platform/runtime/lib/json"
import { asRecord } from "@claxedo/helpers/guards"
import { expiryFromJwt } from "@claxedo/agent-runtime-contract"
import { OPENAI_CLIENT_ID, OPENAI_TOKEN_URL } from "../provider-auth/openai-oauth"
import type { CredentialMetadata } from "@claxedo/server-core/credentials/types"

/**
 * Non-interactive refresh for imported OAuth credentials.
 *
 * A Codex login on disk (`~/.codex/auth.json`, `~/.codex/accounts/*.auth.json`)
 * carries an access token *and* a refresh token; the CLI refreshes the pair
 * transparently on use, so an access token that expired hours ago says nothing
 * about whether the subscription works. `credentials/sync.ts` stores both but
 * derives `expires_at` from the access token's JWT `exp`, which goes stale
 * long before the refresh token does — this module renews the pair so
 * `verifyCredential` never mistakes an idle Codex login for an expired one.
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
export function credentialRefreshToken(secret: string): string | undefined {
  const value = parseJsonRecord(secret)
  if (!value) return undefined
  const tokens = jsonRecord(value.tokens)
  const oauth = jsonRecord(value.oauth)
  return [value.refresh, value.refresh_token, tokens?.refresh_token, oauth?.refresh, oauth?.refresh_token]
    .map(jsonString)
    .find((item) => item !== undefined)
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

  const body = jsonRecord(await response.json().catch(() => undefined))
  const access = jsonString(body?.access_token)
  if (!access) throw new CredentialRefreshError("Credential refresh returned no access token")
  // The provider may or may not rotate the refresh token; keep the current one
  // when it does not, or the next refresh has nothing to present.
  const refresh = jsonString(body?.refresh_token) ?? current
  const idToken = jsonString(body?.id_token)
  const now = options.now ?? Date.now
  const expiresAt = expiryFromJwt(access) ?? now() + fallbackLifetimeMs

  return {
    secret: rewriteSecret(secret, { access, refresh, idToken, expiresAt, now }),
    expiresAt,
  }
}

export type StoredCredentialSecret = {
  read(): Promise<string | null | undefined>
  write(next: RefreshedCredentialSecret): Promise<unknown>
}

const storedRefreshes = new Map<string, Promise<RefreshedCredentialSecret>>()

/**
 * Renew a stored login and write it back, one exchange per credential id in
 * this process: a provider that rotates its refresh token accepts the first
 * exchange and refuses every later one that presents the same token. The
 * secret is read inside the flight, so a caller holding a copy from before
 * another caller's exchange presents the rotated token, not the spent one.
 */
export function refreshStoredCredential(
  credential: CredentialMetadata,
  stored: StoredCredentialSecret,
  options: { fetch?: typeof fetch; now?: () => number } = {},
): Promise<RefreshedCredentialSecret> {
  const running = storedRefreshes.get(credential.id)
  if (running) return running
  const started = (async () => {
    const secret = await stored.read()
    if (!secret) throw new CredentialRefreshError("Credential has no stored secret")
    const next = await refreshCredentialSecret(credential, secret, options)
    await stored.write(next)
    return next
  })().finally(() => storedRefreshes.delete(credential.id))
  storedRefreshes.set(credential.id, started)
  return started
}

/**
 * A login re-pushed at half its remaining life must still be usable when it
 * lands, so it is renewed with this much left: a one-hour token is projected
 * again with thirty minutes to go.
 */
const RENEW_WITHIN_MS = 30 * 60 * 1000

/**
 * The row to hand over: renewed first when it is a refreshable login inside
 * the renewal window, or when its holder reports the token it was handed
 * (expiring at `rejectedExpiresAt`) was refused and the store holds nothing
 * newer. A renewal another process won first is taken from the store rather
 * than reported as a failure, since a rotating refresh token refuses the
 * second exchange.
 */
export async function renewedCredential(
  credential: CredentialMetadata,
  stored: StoredCredentialSecret & { reread(): Promise<CredentialMetadata | undefined> },
  options: { fetch?: typeof fetch; now?: () => number; rejectedExpiresAt?: number } = {},
): Promise<CredentialMetadata> {
  const now = options.now ?? Date.now
  if (!isRefreshableCredential(credential) || !credential.expires_at) return credential
  const rejected = options.rejectedExpiresAt !== undefined && credential.expires_at <= options.rejectedExpiresAt
  if (!rejected && credential.expires_at - now() > RENEW_WITHIN_MS) return credential
  try {
    await refreshStoredCredential(credential, stored, options)
  } catch (error) {
    const current = await stored.reread()
    if ((current?.expires_at ?? 0) > credential.expires_at) return current!
    throw error
  }
  return await stored.reread() ?? credential
}

/**
 * Write the new tokens back into every mirrored position the secret already
 * uses, and only those — consumers read different canonical provider fields,
 * so inventing keys that were not there would change the secret's shape.
 */
function rewriteSecret(
  secret: string,
  next: { access: string; refresh: string; idToken?: string; expiresAt: number; now: () => number },
) {
  const value = parseJsonRecord(secret)
  if (!value) throw new CredentialRefreshError("Credential secret has an unsupported shape")
  const updated: Record<string, unknown> = { ...value }

  if ("access" in updated) updated.access = next.access
  if ("access_token" in updated) updated.access_token = next.access
  if ("refresh" in updated) updated.refresh = next.refresh
  if ("refresh_token" in updated) updated.refresh_token = next.refresh
  if ("expires" in updated) updated.expires = next.expiresAt
  if ("last_refresh" in updated) updated.last_refresh = new Date(next.now()).toISOString()

  const tokens = asRecord(value.tokens)
  if (tokens) {
    updated.tokens = {
      ...tokens,
      access_token: next.access,
      refresh_token: next.refresh,
      ...(next.idToken && "id_token" in tokens ? { id_token: next.idToken } : {}),
    }
  }

  const oauth = asRecord(value.oauth)
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
  const value = parseJsonRecord(body)
  const code = jsonString(value?.error) ?? jsonString(value?.error_description)
  return code?.slice(0, 120)
}

