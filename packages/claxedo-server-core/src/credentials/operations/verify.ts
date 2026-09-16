import { USAGE_WINDOW_NAMES } from "@claxedo/agent-runtime-contract"
import { jsonNumber, jsonRecord, jsonString } from "@claxedo/server-core/platform/runtime/lib/json"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import { CredentialVerificationError } from "../verification-error"
import {
  credentialRefreshToken,
  isRefreshableCredential,
  refreshCredentialSecret,
  type RefreshedCredentialSecret,
} from "./refresh"
import { verifySandboxDriverCredential } from "./sandbox-verify"
import { clampPercent, codexWindowName, usageResetMs, usageWindowName } from "@claxedo/server-core/credentials/usage-windows"
import { credentialSecretMaterial, type CredentialSecretMaterial } from "@claxedo/server-core/credentials/secret-material"
import type { CredentialHealth, CredentialMetadata, CredentialUsageWindow } from "@claxedo/server-core/credentials/types"

const log = Log.create({ service: "credentials-verify" })

export type { CredentialHealth, CredentialUsageWindow } from "@claxedo/server-core/credentials/types"

export { CredentialVerificationError } from "../verification-error"

export type CredentialVerificationOutcome = {
  health: CredentialHealth
  /**
   * Set when a stale access token was renewed during verification. The caller
   * owns persistence — the verifier never writes.
   */
  refreshed?: RefreshedCredentialSecret
  /** Present only when the probe was a usage read, so API keys never carry it. */
  usage?: CredentialUsageWindow[]
  /**
   * The address the subscription is signed in as, when the provider will say.
   * A key authenticates a project, not a person, so it never carries one.
   */
  accountEmail?: string
}

export async function verifyCredential(
  credential: CredentialMetadata,
  secret: string,
  options: { fetch?: typeof fetch; now?: () => number } = {},
): Promise<CredentialVerificationOutcome> {
  const now = options.now ?? Date.now
  const stale = credential.expires_at !== null && credential.expires_at !== undefined && credential.expires_at <= now()

  // A stale access token is only a verdict when nothing can renew it: an
  // imported Codex login ships its refresh token in the same secret, and the
  // account goes on refreshing outside Claxedo.
  let material = secret
  let refreshed: RefreshedCredentialSecret | undefined
  if (stale) {
    if (!isRefreshableCredential(credential) || !credentialRefreshToken(secret)) return { health: "expired" }
    const renewed = await refreshCredentialSecret(credential, secret, options).catch((error: unknown) => {
      // Never swallowed: "expired" with no trace of an attempted renewal is
      // indistinguishable from never having tried.
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
  const anthropicSubscription = anthropic && auth.form === "subscription"
  const probe = providerProbe(auth, anthropic, cursor, openai && auth.form === "subscription")
  const outcome = (
    health: CredentialHealth,
    detail: { usage?: CredentialUsageWindow[]; accountEmail?: string } = {},
  ): CredentialVerificationOutcome => ({
    health,
    ...(refreshed ? { refreshed } : {}),
    ...(detail.usage ? { usage: detail.usage } : {}),
    ...(detail.accountEmail ? { accountEmail: detail.accountEmail } : {}),
  })
  const ask = (url: string, init: RequestInit) =>
    (options.fetch ?? globalThis.fetch)(url, init).catch(() => {
      throw new CredentialVerificationError("Credential provider request failed")
    })
  const response = await ask(probe.url, probe.init)
  if (response.ok) {
    if (probe.usage) {
      const body: unknown = await response.json().catch(() => undefined)
      const accountEmail = anthropicSubscription
        ? await anthropicAccountEmail(auth.token, options.fetch)
        : auth.email
      return outcome("ok", { usage: probe.usage(body), ...(accountEmail ? { accountEmail } : {}) })
    }
    // The OpenAI probe must stream; drop the body rather than leave an open SSE
    // connection for a completion we never read.
    await response.body?.cancel().catch(() => undefined)
    return outcome("ok")
  }
  const verdict = await refusalVerdict(response)
  // A `claude setup-token` is minted with `user:inference` only — the CLI's own
  // words — so the usage read turns away a token that runs every turn. The
  // model catalog is the inference scope's own route, and answers the one
  // question left: whether the provider knows this token at all.
  if (verdict === "auth_failed" && anthropicSubscription) {
    const catalog = await ask("https://api.anthropic.com/v1/models", anthropicInferenceProbe(auth.token))
    if (catalog.ok) {
      await catalog.body?.cancel().catch(() => undefined)
      return outcome("ok")
    }
    return outcome(await refusalVerdict(catalog))
  }
  return outcome(verdict)
}

/** What a non-ok probe answer says about the material, or nothing a verdict can carry. */
async function refusalVerdict(response: Response): Promise<CredentialHealth> {
  const failure = (await response.text().catch(() => "")).slice(0, 8_192).toLowerCase()
  if (
    response.status === 402 ||
    failure.includes("insufficient_quota") ||
    failure.includes("usage_not_included") ||
    failure.includes("billing") ||
    failure.includes("credit balance")
  ) return "no_billing"
  if (failure.includes("token_expired") || failure.includes("expired_token")) return "expired"
  if (response.status === 429) return "rate_capped"
  if (response.status === 401 || response.status === 403) return "auth_failed"
  throw new CredentialVerificationError("Credential provider verification failed")
}

function anthropicInferenceProbe(token: string): RequestInit {
  return {
    method: "GET",
    signal: AbortSignal.timeout(10_000),
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
    },
  }
}

/**
 * The address an Anthropic subscription is signed in as.
 *
 * Only the usage read decides health; this route is asked afterwards and its
 * answer is never a verdict. `/api/oauth/profile` is not granted to every
 * subscription — some plans answer 403 or 404 to a token the usage read has
 * just accepted — so a non-ok status, an unparseable body or a transport fault
 * all leave the account unnamed rather than marking a working token as
 * rejected. Where the account lives in the body also varies, hence the four
 * spellings.
 */
async function anthropicAccountEmail(token: string, fetchImpl: typeof fetch | undefined) {
  const response = await (fetchImpl ?? globalThis.fetch)("https://api.anthropic.com/api/oauth/profile", {
    method: "GET",
    signal: AbortSignal.timeout(10_000),
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
    },
  }).catch(() => undefined)
  if (!response?.ok) return undefined
  const body = jsonRecord(await response.json().catch(() => undefined))
  const account = jsonRecord(body?.account)
  return [account?.email_address, account?.email, body?.email_address, body?.email]
    .map(jsonString)
    .find((item) => item !== undefined)
}

/**
 * Subscription tokens are checked against the vendor's usage read, the same
 * call each CLI's own status screen makes: it authenticates the token, spends
 * no quota, and answers the question a completion cannot, how much of the
 * plan is left. An Anthropic token the read turns away is asked the model
 * catalog next, in `verifyCredential`. API keys have no usage read, so they
 * keep a minimal completion (Anthropic, OpenAI) or the key-introspection
 * route (Cursor).
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

/** `rate_limit.primary_window` / `secondary_window` from the ChatGPT usage read. */
function codexUsageWindows(body: unknown): CredentialUsageWindow[] {
  const rateLimit = jsonRecord(jsonRecord(body)?.rate_limit)
  return (["primary_window", "secondary_window"] as const).flatMap((slot) => {
    const window = jsonRecord(rateLimit?.[slot])
    const used = jsonNumber(window?.used_percent)
    if (!window || used === undefined) return []
    return [{
      window: codexWindowName(slot, jsonNumber(window.limit_window_seconds)),
      usedPercent: clampPercent(used),
      resetsAt: usageResetMs(window.reset_at),
    }]
  })
}

/** `five_hour` / `seven_day` / `seven_day_opus` from Anthropic's OAuth usage read. */
function anthropicUsageWindows(body: unknown): CredentialUsageWindow[] {
  const record = jsonRecord(body)
  return Object.keys(USAGE_WINDOW_NAMES.claude).flatMap((slot) => {
    const window = jsonRecord(record?.[slot])
    const used = jsonNumber(window?.utilization)
    if (!window || used === undefined) return []
    return [{
      window: usageWindowName("claude", slot),
      usedPercent: clampPercent(used),
      resetsAt: usageResetMs(window.resets_at),
    }]
  })
}
