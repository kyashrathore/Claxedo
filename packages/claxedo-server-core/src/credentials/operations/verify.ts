import { jsonNumber, jsonRecord } from "@claxedo/server-core/platform/runtime/lib/json"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import { CredentialVerificationError } from "../verification-error"
import {
  credentialRefreshToken,
  isRefreshableCredential,
  refreshCredentialSecret,
  type RefreshedCredentialSecret,
} from "./refresh"
import { verifySandboxDriverCredential } from "./sandbox-verify"
import { credentialSecretMaterial, type CredentialSecretMaterial } from "@claxedo/server-core/credentials/secret-material"
import type { CredentialHealth, CredentialMetadata } from "@claxedo/server-core/credentials/types"

const log = Log.create({ service: "credentials-verify" })

export type { CredentialHealth } from "@claxedo/server-core/credentials/types"

export { CredentialVerificationError } from "../verification-error"

/** One quota window the provider reports for a subscription. */
export type CredentialUsageWindow = {
  /** `session` (5 h), `weekly`, `weekly_opus`, or the vendor's slot name when it matches none. */
  window: string
  usedPercent: number
  resetsAt: number | null
}

export type CredentialVerificationOutcome = {
  health: CredentialHealth
  /**
   * Set when a stale access token was renewed during verification. The caller
   * owns persistence — the verifier never writes.
   */
  refreshed?: RefreshedCredentialSecret
  /** Present only when the probe was a usage read, so API keys never carry it. */
  usage?: CredentialUsageWindow[]
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
  // expiry as "expired" was calling working subscriptions dead (imported Codex
  // accounts refresh transparently outside Claxedo; only the local expiry
  // check, with no attempt to use the co-located refresh token, made them
  // look permanently dead).
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

  // Sandbox provider keys probe their own vendors and share nothing with the
  // model-provider auth shapes below, so they branch before the secret is read
  // as a token — a driver credential is a field map, not a bearer token.
  if (credential.kind === "sandbox_driver") {
    return { health: await verifySandboxDriverCredential(credential.provider_id, material, options) }
  }

  const anthropic = ["anthropic", "claude-sdk"].includes(credential.provider_id)
  const openai = ["openai", "codex-app-server"].includes(credential.provider_id)
  const cursor = ["cursor", "cursor-sdk"].includes(credential.provider_id)
  if (!anthropic && !openai && !cursor) {
    throw new CredentialVerificationError("Credential provider does not support verification")
  }
  const auth = credentialSecretMaterial({ kind: credential.kind, secret: material })
  if (!auth) throw new CredentialVerificationError("Credential secret has an unsupported shape")
  const probe = providerProbe(auth, anthropic, cursor, openai && auth.form === "subscription")
  const outcome = (health: CredentialHealth, usage?: CredentialUsageWindow[]): CredentialVerificationOutcome => ({
    health,
    ...(refreshed ? { refreshed } : {}),
    ...(usage ? { usage } : {}),
  })
  const response = await (options.fetch ?? globalThis.fetch)(probe.url, probe.init).catch(() => {
    throw new CredentialVerificationError("Credential provider request failed")
  })
  if (response.ok) {
    if (probe.usage) {
      const body: unknown = await response.json().catch(() => undefined)
      return outcome("ok", probe.usage(body))
    }
    // The OpenAI probe must stream; drop the body rather than leave an open SSE
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

/**
 * Subscription tokens are checked against the vendor's usage read, the same
 * call each CLI's own status screen makes: it authenticates the token, spends
 * no quota, and answers the question a completion cannot, how much of the
 * plan is left. API keys have no usage read, so they keep a minimal completion
 * (Anthropic, OpenAI) or the key-introspection route (Cursor).
 */
function providerProbe(
  auth: CredentialSecretMaterial,
  anthropic: boolean,
  cursor: boolean,
  codex: boolean,
): { url: string; init: RequestInit; usage?: (body: unknown) => CredentialUsageWindow[] } {
  if (codex) {
    return {
      url: "https://chatgpt.com/backend-api/wham/usage",
      init: {
        method: "GET",
        signal: AbortSignal.timeout(10_000),
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${auth.token}`,
          ...(auth.accountId ? { "ChatGPT-Account-Id": auth.accountId } : {}),
        },
      },
      usage: codexUsageWindows,
    }
  }
  if (anthropic && auth.form === "subscription") {
    return {
      url: "https://api.anthropic.com/api/oauth/usage",
      init: {
        method: "GET",
        signal: AbortSignal.timeout(10_000),
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${auth.token}`,
          "anthropic-beta": "oauth-2025-04-20",
        },
      },
      usage: anthropicUsageWindows,
    }
  }
  // `GET /v1/me` is Cursor's documented "retrieve information about the API key
  // being used for authentication" route, which is exactly this question and
  // nothing more: it returns key metadata (`apiKeyName`, `createdAt`), spends no
  // model quota, and mutates nothing. The agent SDK's `models.list` would also
  // answer, but a model catalog is a heavier route whose contents vary by plan —
  // a key that authenticates while returning an unexpected catalog is still a
  // valid key, and this probe must not conflate the two.
  if (cursor) {
    return {
      url: "https://api.cursor.com/v1/me",
      init: {
        method: "GET",
        signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Bearer ${auth.token}` },
      },
    }
  }
  if (anthropic) {
    return {
      url: "https://api.anthropic.com/v1/messages",
      init: {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
        headers: {
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": auth.token,
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
    url: "https://api.openai.com/v1/responses",
    init: {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${auth.token}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1-nano",
        input: "Reply with OK.",
        max_output_tokens: 1,
      }),
    },
  }
}

const CODEX_SESSION_WINDOW_SECONDS = 18_000
const CODEX_WEEKLY_WINDOW_SECONDS = 604_800

/**
 * `rate_limit.primary_window` / `secondary_window` from the ChatGPT usage read.
 * A window is named by its `limit_window_seconds`, not its slot: a free plan
 * gets only the weekly window, delivered in the primary slot.
 */
function codexUsageWindows(body: unknown): CredentialUsageWindow[] {
  const rateLimit = jsonRecord(jsonRecord(body)?.rate_limit)
  return (["primary_window", "secondary_window"] as const).flatMap((slot) => {
    const window = jsonRecord(rateLimit?.[slot])
    const used = jsonNumber(window?.used_percent)
    if (!window || used === undefined) return []
    const seconds = jsonNumber(window.limit_window_seconds)
    const name = seconds === CODEX_SESSION_WINDOW_SECONDS
      ? "session"
      : seconds === CODEX_WEEKLY_WINDOW_SECONDS
        ? "weekly"
        : slot
    return [{ window: name, usedPercent: clampPercent(used), resetsAt: usageResetMs(window.reset_at) }]
  })
}

/** `five_hour` / `seven_day` / `seven_day_opus` from Anthropic's OAuth usage read. */
function anthropicUsageWindows(body: unknown): CredentialUsageWindow[] {
  const record = jsonRecord(body)
  const slots = [["five_hour", "session"], ["seven_day", "weekly"], ["seven_day_opus", "weekly_opus"]] as const
  return slots.flatMap(([key, name]) => {
    const window = jsonRecord(record?.[key])
    const used = jsonNumber(window?.utilization)
    if (!window || used === undefined) return []
    return [{ window: name, usedPercent: clampPercent(used), resetsAt: usageResetMs(window.resets_at) }]
  })
}

function clampPercent(value: number) {
  return Math.min(100, Math.max(0, Math.round(value)))
}

/** ChatGPT sends reset times as Unix seconds, Anthropic as ISO strings. */
function usageResetMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}
