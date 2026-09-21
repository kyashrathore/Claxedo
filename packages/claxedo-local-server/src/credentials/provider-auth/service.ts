import { setTimeout as sleep } from "node:timers/promises"
import type { ControlPlaneCredentials } from "@claxedo/server-core/authority/control-plane-contract"
import { SINGLE_TENANT_ORG } from "@claxedo/server-core/credentials/provider-credential.sql"
import { OPENAI_CLIENT_ID, OPENAI_ISSUER } from "@claxedo/server-core/credentials/provider-auth/openai-oauth"
import { accountIdFromClaims, emailFromClaims } from "@claxedo/agent-runtime-contract"
import { num, record, text } from "../../platform/json"

const OPENAI_DEVICE_URL = `${OPENAI_ISSUER}/codex/device`
const OPENAI_DEVICE_REDIRECT_URI = `${OPENAI_ISSUER}/deviceauth/callback`

export type ProviderAuthPrompt =
  | {
      type: "text"
      key: string
      message: string
      placeholder?: string
      when?: { key: string; op: "eq" | "neq"; value: string }
    }
  | {
      type: "select"
      key: string
      message: string
      options: Array<{ label: string; value: string; hint?: string }>
      when?: { key: string; op: "eq" | "neq"; value: string }
    }

export type ProviderAuthMethod = {
  type: "oauth" | "api" | "token"
  label: string
  /** For `token`: the terminal command that prints the token to paste. */
  command?: string
  prompts?: ProviderAuthPrompt[]
}

export type ProviderAuthMethods = Record<string, ProviderAuthMethod[]>

export type ProviderAuthorization = {
  url: string
  method: "auto" | "code"
  instructions: string
}

type CodexPending = {
  providerId: "codex-app-server" | "openai"
  org: string
  deviceAuthId: string
  userCode: string
  intervalMs: number
  startedAt: number
}

type TokenResponse = {
  id_token?: string
  access_token: string
  refresh_token: string
  expires_in?: number
}

export class ProviderAuthError extends Error {
  constructor(
    public readonly code:
      | "provider_auth_unknown_provider"
      | "provider_auth_unknown_method"
      | "provider_auth_method_not_oauth"
      | "provider_auth_missing_pending"
      | "provider_auth_authorize_failed"
      | "provider_auth_callback_failed"
      | "provider_auth_callback_expired"
      | "provider_auth_callback_aborted",
    message: string,
  ) {
    super(message)
  }
}

/**
 * The tenant an OAuth login belongs to.
 *
 * Same convention as the credential router's `requestOrg` (routes/credential.ts):
 * unsigned/local self-host resolves to the NAMED single-tenant partition,
 * signed resolves to the verified `org_id` claim (or the subject when the
 * principal has no org). Blank is NOT a wildcard — it collapses to the named
 * partition, so a call site that forgets to thread the org fails closed into
 * self-host's own tenant rather than into someone else's.
 */
export function providerAuthOrg(org?: string | null): string {
  return org?.trim() || SINGLE_TENANT_ORG
}

export type ProviderAuthService = {
  methods: () => ProviderAuthMethods
  authorize: (input: { providerId: string; method?: number; inputs?: Record<string, string>; org?: string }) => Promise<ProviderAuthorization | null>
  callback: (input: { providerId: string; method?: number; code?: string; org?: string; signal?: AbortSignal }) => Promise<boolean>
}

type ProviderAuthOptions = {
  fetch?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  pollingSafetyMs?: number
  /** How long an unclaimed in-flight authorization stays claimable. */
  pendingTtlMs?: number
}

/**
 * Upstream device codes expire on their own; this is the local stand-in for
 * that expiry. It bounds how long a started-but-never-completed authorization
 * stays claimable AND how long a callback may keep polling for it — matching
 * the ~15 minutes OpenAI gives a device_auth_id before the poll can only ever
 * fail.
 */
const DEFAULT_PENDING_TTL_MS = 15 * 60 * 1000

export function providerAuthMethods(): ProviderAuthMethods {
  return {
    anthropic: [
      { type: "token", label: "Claude subscription token", command: "claude setup-token" },
      { type: "api", label: "API Key" },
    ],
    "claude-sdk": [
      { type: "token", label: "Claude subscription token", command: "claude setup-token" },
      { type: "api", label: "API Key" },
    ],
    "codex-app-server": [
      { type: "oauth", label: "ChatGPT Pro/Plus (headless)" },
      { type: "api", label: "API Key" },
    ],
    "cursor-sdk": [{ type: "api", label: "API Key" }],
    openai: [
      { type: "oauth", label: "ChatGPT Pro/Plus (headless)" },
      { type: "api", label: "API Key" },
    ],
  }
}

export function createProviderAuthService(
  credentials: ControlPlaneCredentials,
  options: ProviderAuthOptions = {},
): ProviderAuthService {
  /**
   * In-flight device authorizations, keyed by TENANT + provider.
   *
   * Keying by `providerId` alone made this a cross-tenant hole on any
   * multi-org box: org A starting a Codex login and org B posting the
   * callback let org B consume org A's in-flight authorization and have the
   * resulting ChatGPT/OpenAI token written into org B's credential store.
   *
   * There is no OAuth `state` to bind to here — this is OpenAI's DEVICE
   * authorization flow (device_auth_id + user_code, polled server-side), not a
   * redirect flow, so no `state` ever leaves or returns and the route's `code`
   * body field is unused. The pending map IS the binding, which is exactly why
   * its key has to carry the tenant.
   *
   * Key is JSON-encoded rather than concatenated so an org id containing the
   * separator cannot forge another tenant's key.
   */
  const pending = new Map<string, CodexPending>()
  const pendingKey = (org: string, providerId: string) => JSON.stringify([org, providerId])
  const request = options.fetch ?? globalThis.fetch
  const clock = options.now ?? Date.now
  const wait = options.sleep ?? sleep
  const pollingSafetyMs = options.pollingSafetyMs ?? 3_000
  const pendingTtlMs = options.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS

  const methods = () => providerAuthMethods()

  const authorize = async (input: { providerId: string; method?: number; org?: string }) => {
    const method = requireMethod(methods(), input.providerId, input.method ?? 0)
    if (method.type !== "oauth") {
      throw new ProviderAuthError("provider_auth_method_not_oauth", "Selected provider method is not OAuth")
    }
    if (!isCodexProvider(input.providerId)) {
      throw new ProviderAuthError("provider_auth_unknown_provider", `OAuth is not supported for ${input.providerId}`)
    }

    const response = await request(`${OPENAI_ISSUER}/api/accounts/deviceauth/usercode`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "claxedo",
      },
      body: JSON.stringify({ client_id: OPENAI_CLIENT_ID }),
    })
    if (!response.ok) {
      throw new ProviderAuthError("provider_auth_authorize_failed", `Device authorization failed: ${response.status}`)
    }

    const body = record(await response.json()) ?? {}
    if (typeof body.device_auth_id !== "string" || typeof body.user_code !== "string") {
      throw new ProviderAuthError("provider_auth_authorize_failed", "Device authorization returned an invalid body")
    }

    const org = providerAuthOrg(input.org)
    pending.set(pendingKey(org, input.providerId), {
      providerId: input.providerId,
      org,
      deviceAuthId: body.device_auth_id,
      userCode: body.user_code,
      intervalMs: Math.max(typeof body.interval === "string" ? Number.parseInt(body.interval) : Number(body.interval) || 5, 1) * 1000,
      startedAt: clock(),
    })

    return {
      url: OPENAI_DEVICE_URL,
      instructions: `Enter code: ${body.user_code}`,
      method: "auto" as const,
    }
  }

  const callback = async (input: { providerId: string; method?: number; code?: string; org?: string; signal?: AbortSignal }) => {
    const method = requireMethod(methods(), input.providerId, input.method ?? 0)
    if (method.type !== "oauth") {
      throw new ProviderAuthError("provider_auth_method_not_oauth", "Selected provider method is not OAuth")
    }
    if (!isCodexProvider(input.providerId)) {
      throw new ProviderAuthError("provider_auth_unknown_provider", `OAuth is not supported for ${input.providerId}`)
    }

    const org = providerAuthOrg(input.org)
    const key = pendingKey(org, input.providerId)
    const item = pending.get(key)
    // An authorization started by ANOTHER tenant is not visible here at all —
    // this reads as "never started", which is what it is for this caller.
    if (!item) throw new ProviderAuthError("provider_auth_missing_pending", "OAuth authorization has not been started")
    const deadline = item.startedAt + pendingTtlMs
    if (clock() > deadline) {
      pending.delete(key)
      throw new ProviderAuthError("provider_auth_missing_pending", "OAuth authorization has expired — start it again")
    }
    let tokens: TokenResponse
    try {
      tokens = await exchangeDeviceTokens(request, item, wait, pollingSafetyMs, {
        clock,
        deadline,
        signal: input.signal,
      })
    } finally {
      // The attempt is over once its bounded poll ends — approved, refused,
      // expired or disconnected — so the entry cannot be claimed twice or sit
      // in the map until some later caller trips the TTL check.
      pending.delete(key)
    }

    const expires = clock() + (tokens.expires_in ?? 3600) * 1000
    const accountId = extractAccountId(tokens)
    // Every row the accounts list shows is named by its account. Without the
    // address off the login's own claims each of a reader's ChatGPT logins is
    // listed under the same words and none of them can be told apart.
    const email = emailFromClaims({ ...(tokens.id_token ? { id_token: tokens.id_token } : {}), access_token: tokens.access_token })
    // Org-scoped writes: without the scope both statements ran against the
    // single-tenant partition, so a signed multi-org box wrote every tenant's
    // OAuth login into the same rows.
    await credentials.deleteCredentialsByProvider(input.providerId, undefined, org)
    await credentials.putCredential({
      provider_id: input.providerId,
      kind: "oauth_token",
      source: "managed",
      label: email ?? (input.providerId === "codex-app-server" ? "ChatGPT OAuth" : "OpenAI OAuth"),
      ...(accountId ? { account_id: accountId } : {}),
      expires_at: expires,
      secret: input.providerId === "codex-app-server"
        ? JSON.stringify(codexSecret(tokens, expires, accountId))
        : JSON.stringify(openaiSecret(tokens, expires, accountId)),
    }, org)
    return true
  }

  return { methods, authorize, callback }
}

function requireMethod(methods: ProviderAuthMethods, providerId: string, index: number) {
  const providerMethods = methods[providerId]
  if (!providerMethods) {
    throw new ProviderAuthError("provider_auth_unknown_provider", `Unknown provider ${providerId}`)
  }
  const method = providerMethods[index]
  if (!method) {
    throw new ProviderAuthError("provider_auth_unknown_method", `Unknown auth method ${index} for ${providerId}`)
  }
  return method
}

function isCodexProvider(providerId: string): providerId is "codex-app-server" | "openai" {
  return providerId === "codex-app-server" || providerId === "openai"
}

async function exchangeDeviceTokens(
  request: typeof fetch,
  pending: CodexPending,
  wait: (ms: number) => Promise<void>,
  pollingSafetyMs: number,
  bounds: { clock: () => number; deadline: number; signal?: AbortSignal },
): Promise<TokenResponse> {
  // Two things end a device poll: the caller disconnecting and the
  // authorization expiring. One controller joins them so the in-flight poll
  // request observes both; without the deadline a user who never completes
  // device login holds the callback request open forever.
  const poll = new AbortController()
  const stop = () => poll.abort()
  bounds.signal?.addEventListener("abort", stop, { once: true })
  // A listener registered on an already-aborted signal never fires.
  if (bounds.signal?.aborted) stop()
  const timer = setTimeout(stop, Math.max(bounds.deadline - bounds.clock(), 0))
  const ended = () =>
    bounds.signal?.aborted
      ? new ProviderAuthError("provider_auth_callback_aborted", "Device authorization was cancelled")
      : new ProviderAuthError("provider_auth_callback_expired", "Device authorization expired before it was approved")

  try {
    while (true) {
      if (poll.signal.aborted) throw ended()
      let codeResponse: Response
      try {
        codeResponse = await request(`${OPENAI_ISSUER}/api/accounts/deviceauth/token`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "claxedo",
          },
          body: JSON.stringify({
            device_auth_id: pending.deviceAuthId,
            user_code: pending.userCode,
          }),
          signal: poll.signal,
        })
      } catch (error) {
        if (poll.signal.aborted) throw ended()
        throw error
      }

      if (!codeResponse.ok) {
        if (codeResponse.status === 403 || codeResponse.status === 404) {
          const remaining = bounds.deadline - bounds.clock()
          if (remaining <= 0) throw ended()
          await pause(Math.min(pending.intervalMs + pollingSafetyMs, remaining), wait, poll.signal)
          continue
        }
        throw new ProviderAuthError("provider_auth_callback_failed", `Device token polling failed: ${codeResponse.status}`)
      }

      const code = record(await codeResponse.json()) ?? {}
      if (typeof code.authorization_code !== "string" || typeof code.code_verifier !== "string") {
        throw new ProviderAuthError("provider_auth_callback_failed", "Device token polling returned an invalid body")
      }

      let tokenResponse: Response
      try {
        tokenResponse = await request(`${OPENAI_ISSUER}/oauth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code: code.authorization_code,
            redirect_uri: OPENAI_DEVICE_REDIRECT_URI,
            client_id: OPENAI_CLIENT_ID,
            code_verifier: code.code_verifier,
          }).toString(),
          signal: poll.signal,
        })
      } catch (error) {
        if (poll.signal.aborted) throw ended()
        throw error
      }
      if (!tokenResponse.ok) {
        throw new ProviderAuthError("provider_auth_callback_failed", `Token exchange failed: ${tokenResponse.status}`)
      }

      return tokenResponseFrom(await tokenResponse.json(), "provider_auth_callback_failed")
    }
  } finally {
    clearTimeout(timer)
    bounds.signal?.removeEventListener("abort", stop)
  }
}

/** Sleeps between polls, waking early when the poll's signal fires. */
async function pause(ms: number, wait: (ms: number) => Promise<void>, signal: AbortSignal) {
  if (signal.aborted || ms <= 0) return
  let onAbort: (() => void) | undefined
  try {
    await Promise.race([
      wait(ms),
      new Promise<void>((resolve) => {
        onAbort = resolve
        signal.addEventListener("abort", onAbort, { once: true })
      }),
    ])
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort)
  }
}

/** The one place an OAuth token body becomes a {@link TokenResponse}. */
function tokenResponseFrom(value: unknown, code: ProviderAuthError["code"]): TokenResponse {
  const body = record(value) ?? {}
  const access_token = text(body.access_token)
  const refresh_token = text(body.refresh_token)
  if (!access_token || !refresh_token) {
    throw new ProviderAuthError(code, "Token exchange returned an invalid body")
  }
  return {
    access_token,
    refresh_token,
    ...(text(body.id_token) ? { id_token: text(body.id_token) } : {}),
    ...(num(body.expires_in) === undefined ? {} : { expires_in: num(body.expires_in) }),
  }
}

function extractAccountId(tokens: TokenResponse) {
  return accountIdFromClaims({ id_token: tokens.id_token, access_token: tokens.access_token })
}

function openaiSecret(tokens: TokenResponse, expires: number, accountId: string | undefined) {
  return {
    type: "oauth",
    refresh: tokens.refresh_token,
    access: tokens.access_token,
    expires,
    ...(accountId ? { accountId } : {}),
  }
}

function codexSecret(tokens: TokenResponse, expires: number, accountId: string | undefined) {
  return {
    type: "codex_auth",
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      ...(tokens.id_token ? { id_token: tokens.id_token } : {}),
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      ...(accountId ? { account_id: accountId } : {}),
    },
    last_refresh: new Date().toISOString(),
    refresh: tokens.refresh_token,
    access: tokens.access_token,
    expires,
    ...(accountId ? { account_id: accountId } : {}),
    oauth: {
      refresh: tokens.refresh_token,
      access: tokens.access_token,
      expires,
      ...(accountId ? { account_id: accountId } : {}),
    },
  }
}
