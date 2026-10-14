import { USAGE_WINDOW_NAMES } from "@claxedo/agent-runtime-contract"
import { jsonNumber, jsonRecord, jsonString } from "@claxedo/server-core/platform/runtime/lib/json"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import { withDeadlineSignal } from "@claxedo/helpers/deadline"
import { CredentialVerificationError } from "../verification-error"
import {
  CredentialRefreshError,
  credentialRefreshToken,
  isRefreshableCredential,
  refreshCredentialSecret,
  type RefreshedCredentialSecret,
} from "./refresh"
import { verifySandboxDriverCredential } from "./sandbox-verify"
import { readVendorAnswer, vendorRefusal, vendorReply, type VendorRefusal, type VendorReply } from "./vendor-answer"
import { credentialUndeliverable } from "@claxedo/server-core/credentials/health"
import { clampPercent, codexWindowName, usageResetMs, usageWindowName } from "@claxedo/server-core/credentials/usage-windows"
import { credentialSecretMaterial, type CredentialSecretMaterial } from "@claxedo/server-core/credentials/secret-material"
import type { CredentialHealth, CredentialMetadata, CredentialUsageWindow, CredentialVerdictEvidence } from "@claxedo/server-core/credentials/types"

const log = Log.create({ service: "credentials-verify" })
const PROVIDER_REQUEST_TIMEOUT_MS = 10_000

const ANTHROPIC_CATALOG_URL = "https://api.anthropic.com/v1/models"
const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
const ANTHROPIC_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile"

export type { CredentialHealth, CredentialUsageWindow } from "@claxedo/server-core/credentials/types"

export { CredentialVerificationError } from "../verification-error"

export type CredentialVerificationOutcome = {
  health: CredentialHealth
  /** The vendor's answer behind every verdict other than `ok`. */
  evidence?: CredentialVerdictEvidence
  /**
   * Set when a stale access token was renewed during verification. The caller
   * owns persistence — the verifier never writes.
   */
  refreshed?: RefreshedCredentialSecret
  /** Present only when the probe was a usage read, so API keys never carry it. */
  usage?: CredentialUsageWindow[]
  /**
   * The usage read's refusal of a token the vendor accepted: the plan's
   * windows could not be read this time, and this is the vendor's word on why.
   */
  usageRefused?: CredentialVerdictEvidence
  /**
   * The address the subscription is signed in as, when the provider will say.
   * A key authenticates a project, not a person, so it never carries one.
   */
  accountEmail?: string
}

type OutcomeDetail = Omit<CredentialVerificationOutcome, "health" | "refreshed">

export async function verifyCredential(
  credential: CredentialMetadata,
  secret: string,
  options: {
    fetch?: typeof fetch
    now?: () => number
    /** Renews a stale login; a caller verifying a stored row passes the shared stored-row refresh. */
    refresh?: (credential: CredentialMetadata, secret: string) => Promise<RefreshedCredentialSecret>
  } = {},
): Promise<CredentialVerificationOutcome> {
  const now = options.now ?? Date.now
  const stale = credential.expires_at !== null && credential.expires_at !== undefined && credential.expires_at <= now()

  // A stale access token is only a verdict when nothing can renew it: an
  // imported Codex login ships its refresh token in the same secret, and the
  // account goes on refreshing outside Claxedo.
  let material = secret
  let refreshed: RefreshedCredentialSecret | undefined
  const refresh = options.refresh ?? ((row: CredentialMetadata, current: string) => refreshCredentialSecret(row, current, options))
  const renewable = () => isRefreshableCredential(credential) && credentialRefreshToken(material) !== undefined
  if (stale) {
    if (!renewable()) return { health: "expired" }
    const renewal = await renewLogin(credential, secret, refresh)
    if ("rejected" in renewal) return { health: "expired", evidence: renewal.rejected }
    refreshed = renewal.renewed
    material = renewal.renewed.secret
  }

  // Sandbox provider keys probe their own vendors and share nothing with the
  // model-provider auth shapes below, so they branch before the secret is read
  // as a token — a driver credential is a field map, not a bearer token.
  if (credential.kind === "sandbox_driver") {
    return await verifySandboxDriverCredential(credential.provider_id, material, options)
  }

  const anthropic = ["anthropic", "claude-sdk"].includes(credential.provider_id)
  const openai = ["openai", "codex-app-server"].includes(credential.provider_id)
  const cursor = ["cursor", "cursor-sdk"].includes(credential.provider_id)
  if (!anthropic && !openai && !cursor) {
    throw new CredentialVerificationError("credential_verification_unsupported", "Credential provider does not support verification")
  }
  const auth = credentialSecretMaterial({ kind: credential.kind, secret: material })
  if (!auth) throw new CredentialVerificationError("credential_shape_invalid", "Credential secret has an unsupported shape")
  const outcome = (health: CredentialHealth, detail: OutcomeDetail = {}): CredentialVerificationOutcome =>
    ({ health, ...(refreshed ? { refreshed } : {}), ...detail })
  const ask = (url: string, init: RequestInit) =>
    withDeadlineSignal(PROVIDER_REQUEST_TIMEOUT_MS, (signal) =>
      (options.fetch ?? globalThis.fetch)(url, { ...init, signal }).then(readProbeAnswer).catch(() => {
        throw new CredentialVerificationError("credential_provider_unavailable", "Credential provider request failed")
      }))

  if (anthropic && auth.form === "subscription") return outcome(...await anthropicSubscriptionVerdict(auth.token, ask, options.fetch))

  const codex = openai && auth.form === "subscription"
  const probe = providerProbe(auth, anthropic, cursor, codex)
  const answer = await ask(probe.url, probe.init)
  if (answer.ok) {
    if (!probe.usage) return outcome("ok")
    return outcome("ok", { usage: probe.usage(answer.json), ...(auth.email ? { accountEmail: auth.email } : {}) })
  }
  let refusal: VendorRefusal
  try {
    refusal = vendorRefusal(answer.reply)
  } catch (inconclusive: unknown) {
    // chatgpt.com answers a Worker with the edge's challenge page, so from
    // there the usage read can neither accept nor refuse a ChatGPT login. Its
    // refresh grant can: auth.openai.com answers Worker egress with its own
    // JSON (probed from Cloudflare colos SIN and WAW, 2026-10-14), so the token
    // endpoint taking the stored refresh token is the auth server's word that
    // the login is live, and refusing it is the end of the login the stale
    // path reports. The exchange rotates a single-use refresh token, so it is
    // spent only where a verdict is needed: a login renewed for being stale is
    // already proven, a row the vendor refused can be recovered by it, and a
    // deliverable row is left as it is. The windows stay unread either way,
    // and the card says so.
    if (!codex || !renewable()) throw inconclusive
    const unread = { usageRefused: readVendorAnswer(answer.reply).evidence }
    if (refreshed) return outcome("ok", unread)
    if (!credentialUndeliverable(credential)) throw inconclusive
    const renewal = await renewLogin(credential, material, refresh)
    if ("rejected" in renewal) return outcome("expired", { evidence: renewal.rejected })
    refreshed = renewal.renewed
    return outcome("ok", unread)
  }
  return outcome(refusal.health, { evidence: refusal.evidence })
}

/**
 * The stored login renewed through the one refresh path the runtime uses,
 * or the token endpoint's own refusal of the grant, which is the real end of
 * the login: the user has to reconnect, which is exactly what "expired" tells
 * every surface. An answer that is not the endpoint's decides nothing and is
 * thrown as the provider being unavailable.
 */
async function renewLogin(
  credential: CredentialMetadata,
  secret: string,
  refresh: (credential: CredentialMetadata, secret: string) => Promise<RefreshedCredentialSecret>,
): Promise<{ renewed: RefreshedCredentialSecret } | { rejected: CredentialVerdictEvidence }> {
  try {
    const renewed = await refresh(credential, secret)
    log.info("Credential refreshed during verification", {
      credential_id: credential.id,
      provider_id: credential.provider_id,
      expires_at: renewed.expiresAt,
    })
    return { renewed }
  } catch (error: unknown) {
    // Never swallowed: "expired" with no trace of an attempted renewal is
    // indistinguishable from never having tried.
    log.warn("Credential refresh failed", {
      credential_id: credential.id,
      provider_id: credential.provider_id,
      error: error instanceof Error ? error.message : String(error),
    })
    if (error instanceof CredentialRefreshError && error.rejected) return { rejected: error.rejected }
    throw new CredentialVerificationError("credential_provider_unavailable", error instanceof Error ? error.message : "Credential refresh request failed")
  }
}

/**
 * A vendor's answer with its body already taken inside the request deadline:
 * the JSON of an accepted answer, the status, headers and text of a refusal.
 * The OpenAI key probe streams, so an accepted body that is not JSON is dropped
 * rather than left as an open connection for a completion never read.
 */
type ProbeAnswer = { ok: true; json: unknown } | { ok: false; reply: VendorReply }

async function readProbeAnswer(response: Response): Promise<ProbeAnswer> {
  if (!response.ok) return { ok: false, reply: await vendorReply(response) }
  const text = await response.text().catch(() => "")
  try {
    return { ok: true, json: JSON.parse(text) as unknown }
  } catch {
    return { ok: true, json: undefined }
  }
}

/**
 * An Anthropic subscription is judged by the model catalog, the inference
 * scope's own route: it is what every turn on the token spends, and a
 * `claude setup-token` is minted with `user:inference` and nothing else. The
 * usage read is auxiliary. It adds the plan's windows when the token carries
 * `user:profile`, and its refusal — the scope a setup-token lacks, or the
 * per-token throttle Anthropic puts on this route with a retry-after of nearly
 * an hour — costs the account its windows and never its verdict.
 */
async function anthropicSubscriptionVerdict(
  token: string,
  ask: (url: string, init: RequestInit) => Promise<ProbeAnswer>,
  fetchImpl: typeof fetch | undefined,
): Promise<[CredentialHealth, OutcomeDetail]> {
  const catalog = await ask(ANTHROPIC_CATALOG_URL, anthropicInferenceProbe(token))
  if (!catalog.ok) {
    const refusal = vendorRefusal(catalog.reply)
    return [refusal.health, { evidence: refusal.evidence }]
  }
  const usage = await ask(ANTHROPIC_USAGE_URL, anthropicOAuthRead(token))
  if (!usage.ok) return ["ok", { usageRefused: readVendorAnswer(usage.reply).evidence }]
  const accountEmail = await anthropicAccountEmail(token, fetchImpl)
  return ["ok", { usage: anthropicUsageWindows(usage.json), ...(accountEmail ? { accountEmail } : {}) }]
}

function anthropicInferenceProbe(token: string): RequestInit {
  return {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
    },
  }
}

function anthropicOAuthRead(token: string): RequestInit {
  return {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
    },
  }
}

/**
 * The address an Anthropic subscription is signed in as.
 *
 * Asked only after the usage read has answered, and never a verdict:
 * `/api/oauth/profile` is not granted to every subscription — some plans
 * answer 403 or 404 to a token the catalog has just accepted — so a non-ok
 * status, an unparseable body or a transport fault all leave the account
 * unnamed rather than marking a working token as rejected. Where the account
 * lives in the body also varies, hence the four spellings.
 */
async function anthropicAccountEmail(token: string, fetchImpl: typeof fetch | undefined) {
  return withDeadlineSignal(PROVIDER_REQUEST_TIMEOUT_MS, async (signal) => {
    const response = await (fetchImpl ?? globalThis.fetch)(ANTHROPIC_PROFILE_URL, { ...anthropicOAuthRead(token), signal }).catch(() => undefined)
    if (!response?.ok) return undefined
    const body = jsonRecord(await response.json().catch(() => undefined))
    const account = jsonRecord(body?.account)
    return [account?.email_address, account?.email, body?.email_address, body?.email]
      .map(jsonString)
      .find((item) => item !== undefined)
  })
}

/**
 * A ChatGPT login is checked against the vendor's usage read, the same call
 * Codex's own status screen makes: it authenticates the token, spends no
 * quota, and answers the question a completion cannot, how much of the plan
 * is left. API keys have no usage read, so they keep a minimal completion
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
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${auth.token}`,
          ...(auth.accountId ? { "ChatGPT-Account-Id": auth.accountId } : {}),
        },
      },
      usage: codexUsageWindows,
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
        headers: { Authorization: `Bearer ${auth.token}` },
      },
    }
  }
  if (anthropic) {
    return {
      url: "https://api.anthropic.com/v1/messages",
      init: {
        method: "POST",
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
