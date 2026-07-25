import { Log } from "../log"
import {
  credentialRefreshToken,
  isRefreshableCredential,
  refreshCredentialSecret,
  type RefreshedCredentialSecret,
} from "./refresh"
import type { CredentialHealth, CredentialMetadata } from "./types"

const log = Log.create({ service: "credentials-verify" })

export type { CredentialHealth } from "./types"

export class CredentialVerificationError extends Error {}

export type CredentialVerificationOutcome = {
  health: CredentialHealth
  /**
   * Set when a stale access token was renewed during verification. The caller
   * owns persistence — the verifier never writes.
   */
  refreshed?: RefreshedCredentialSecret
}

export async function verifyCredential(
  credential: CredentialMetadata,
  secret: string,
  options: { fetch?: typeof fetch; now?: () => number } = {},
): Promise<CredentialVerificationOutcome> {
  const now = options.now ?? Date.now
  const stale = credential.expires_at !== null && credential.expires_at !== undefined && credential.expires_at <= now()

  // A stale access token is only a verdict when nothing can renew it. Imported
  // Codex logins ship a refresh token in the same secret, so treating the local
  // expiry as "expired" was calling working subscriptions dead — see
  // docs/plans/2026-07-25-002-feat-onboarding-full-page-setup-plan.md §2.1.
  let material = secret
  let refreshed: RefreshedCredentialSecret | undefined
  if (stale) {
    if (!isRefreshableCredential(credential) || !credentialRefreshToken(secret)) return { health: "expired" }
    const renewed = await refreshCredentialSecret(credential, secret, options).catch((error: unknown) => {
      // Never swallow this silently: "expired" with no trace of an attempted
      // renewal is indistinguishable from the bug this replaced.
      log.warn("Credential refresh failed", {
        credential_id: credential.id,
        provider_id: credential.provider_id,
        error: error instanceof Error ? error.message : String(error),
      })
      return undefined
    })
    // A rejected refresh token is the real end of the login: the user has to
    // reconnect, which is exactly what "expired" tells every surface.
    if (!renewed) return { health: "expired" }
    log.info("Credential refreshed during verification", {
      credential_id: credential.id,
      provider_id: credential.provider_id,
      expires_at: renewed.expiresAt,
    })
    refreshed = renewed
    material = renewed.secret
  }

  const anthropic = ["anthropic", "claude-acp", "claude-sdk"].includes(credential.provider_id)
  const openai = ["openai", "codex-acp", "codex-app-server"].includes(credential.provider_id)
  if (!anthropic && !openai) {
    throw new CredentialVerificationError("Credential provider does not support verification")
  }
  const auth = verificationAuth(credential, material)
  if (!auth) throw new CredentialVerificationError("Credential secret has an unsupported shape")
  const codex = openai && credential.kind === "oauth_token"
  const probe = providerProbe(credential, auth, anthropic, codex)
  const outcome = (health: CredentialHealth): CredentialVerificationOutcome => ({
    health,
    ...(refreshed ? { refreshed } : {}),
  })
  const response = await (options.fetch ?? globalThis.fetch)(probe.url, probe.init).catch(() => {
    throw new CredentialVerificationError("Credential provider request failed")
  })
  if (response.ok) {
    // The Codex probe must stream; drop the body rather than leave an open SSE
    // connection for a completion we never read.
    await response.body?.cancel().catch(() => undefined)
    return outcome("ok")
  }
  const failure = (await response.text().catch(() => "")).slice(0, 8_192).toLowerCase()
  if (
    response.status === 402 ||
    failure.includes("insufficient_quota") ||
    failure.includes("usage_not_included") ||
    failure.includes("billing") ||
    failure.includes("credit balance")
  ) return outcome("no_billing")
  if (failure.includes("token_expired") || failure.includes("expired_token")) return outcome("expired")
  if (response.status === 429) return outcome("rate_capped")
  if (response.status === 401 || response.status === 403) return outcome("auth_failed")
  throw new CredentialVerificationError("Credential provider verification failed")
}

function providerProbe(
  credential: CredentialMetadata,
  auth: { token: string; accountId?: string },
  anthropic: boolean,
  codex: boolean,
) {
  if (anthropic) {
    return {
      url: "https://api.anthropic.com/v1/messages",
      init: {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
        headers: {
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
          ...(credential.kind === "oauth_token"
            ? { Authorization: `Bearer ${auth.token}`, "anthropic-beta": "oauth-2025-04-20" }
            : { "x-api-key": auth.token }),
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5",
          messages: [{ role: "user", content: "Reply with OK." }],
          max_tokens: 1,
        }),
      },
    }
  }
  return {
    url: codex ? "https://chatgpt.com/backend-api/codex/responses" : "https://api.openai.com/v1/responses",
    init: {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${auth.token}`,
        ...(codex && auth.accountId ? { "ChatGPT-Account-Id": auth.accountId } : {}),
      },
      // The ChatGPT-backed Codex endpoint is not the public Responses API and
      // rejects its request shape outright: `input` must be a list, `store`
      // must be false, `stream` must be true, and `max_output_tokens` is not a
      // supported parameter. Sending the public shape returned 400 for every
      // valid subscription, which the mapping below turns into a hard error —
      // so a working ChatGPT plan could never be verified at all.
      body: JSON.stringify(codex
        ? {
          model: "gpt-5.4-mini",
          input: [{ role: "user", content: [{ type: "input_text", text: "Reply with OK." }] }],
          stream: true,
          store: false,
        }
        : {
          model: "gpt-4.1-nano",
          input: "Reply with OK.",
          max_output_tokens: 1,
        }),
    },
  }
}

function verificationAuth(credential: CredentialMetadata, secret: string) {
  if (credential.kind === "api_key") return { token: secret }
  const value = jsonRecord(secret)
  if (!value) return
  const tokens = record(value.tokens)
  const oauth = record(value.oauth)
  const claude = record(value.claudeAiOauth)
  const token = [
    value.access,
    value.access_token,
    tokens?.access_token,
    oauth?.access,
    oauth?.access_token,
    claude?.accessToken,
    claude?.access_token,
  ].find((item): item is string => typeof item === "string" && item.length > 0)
  if (!token) return
  const accountId = [value.account_id, value.accountId, tokens?.account_id, oauth?.account_id].find(
    (item): item is string => typeof item === "string" && item.length > 0,
  )
  return { token, ...(accountId ? { accountId } : {}) }
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
