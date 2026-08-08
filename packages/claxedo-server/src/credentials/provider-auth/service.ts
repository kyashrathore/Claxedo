import { setTimeout as sleep } from "node:timers/promises"
import type { ControlPlaneCredentials } from "../../authority/services"
import { SINGLE_TENANT_ORG } from "@claxedo/server-core/credentials/provider-credential.sql"
import { OPENAI_CLIENT_ID, OPENAI_ISSUER } from "./openai-oauth"

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
  type: "oauth" | "api"
  label: string
  prompts?: ProviderAuthPrompt[]
}

export type ProviderAuthMethods = Record<string, ProviderAuthMethod[]>

export type ProviderAuthorization = {
  url: string
  method: "auto" | "code"
  instructions: string
}

type CodexPending = {
  providerId: "codex-acp" | "openai"
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
      | "provider_auth_callback_failed",
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
  callback: (input: { providerId: string; method?: number; code?: string; org?: string }) => Promise<boolean>
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
 * Upstream device codes expire on their own; this only bounds how long a
 * started-but-never-completed authorization sits in memory waiting to be
 * consumed. The UI posts the callback immediately after authorize, so the
 * real gap is seconds.
 */
const DEFAULT_PENDING_TTL_MS = 15 * 60 * 1000

export function providerAuthMethods(): ProviderAuthMethods {
  return {
    "claude-acp": [{ type: "api", label: "API Key" }],
    "claude-sdk": [{ type: "api", label: "API Key" }],
    "codex-acp": [
      { type: "oauth", label: "ChatGPT Pro/Plus (headless)" },
      { type: "api", label: "API Key" },
    ],
    "codex-app-server": [{ type: "api", label: "API Key" }],
    "cursor-acp": [{ type: "api", label: "API Key" }],
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
   * multi-org box: org A starting a `codex-acp` login and org B posting the
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

    const body = await response.json() as {
      device_auth_id?: unknown
      user_code?: unknown
      interval?: unknown
    }
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

  const callback = async (input: { providerId: string; method?: number; org?: string }) => {
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
    if (clock() - item.startedAt > pendingTtlMs) {
      pending.delete(key)
      throw new ProviderAuthError("provider_auth_missing_pending", "OAuth authorization has expired — start it again")
    }
    const tokens = await exchangeDeviceTokens(request, item, wait, pollingSafetyMs)
    pending.delete(key)

    const expires = clock() + (tokens.expires_in ?? 3600) * 1000
    const accountId = extractAccountId(tokens)
    // Org-scoped writes: without the scope both statements ran against the
    // single-tenant partition, so a signed multi-org box wrote every tenant's
    // OAuth login into the same rows.
    await credentials.deleteCredentialsByProvider(input.providerId, undefined, org)
    await credentials.putCredential({
      provider_id: input.providerId,
      kind: "oauth_token",
      source: "managed",
      label: input.providerId === "codex-acp" ? "ChatGPT OAuth" : "OpenAI OAuth",
      ...(accountId ? { account_id: accountId } : {}),
      expires_at: expires,
      secret: input.providerId === "codex-acp"
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

function isCodexProvider(providerId: string): providerId is "codex-acp" | "openai" {
  return providerId === "codex-acp" || providerId === "openai"
}

async function exchangeDeviceTokens(
  request: typeof fetch,
  pending: CodexPending,
  wait: (ms: number) => Promise<void>,
  pollingSafetyMs: number,
): Promise<TokenResponse> {
  while (true) {
    const codeResponse = await request(`${OPENAI_ISSUER}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "claxedo",
      },
      body: JSON.stringify({
        device_auth_id: pending.deviceAuthId,
        user_code: pending.userCode,
      }),
    })

    if (!codeResponse.ok) {
      if (codeResponse.status === 403 || codeResponse.status === 404) {
        await wait(pending.intervalMs + pollingSafetyMs)
        continue
      }
      throw new ProviderAuthError("provider_auth_callback_failed", `Device token polling failed: ${codeResponse.status}`)
    }

    const code = await codeResponse.json() as {
      authorization_code?: unknown
      code_verifier?: unknown
    }
    if (typeof code.authorization_code !== "string" || typeof code.code_verifier !== "string") {
      throw new ProviderAuthError("provider_auth_callback_failed", "Device token polling returned an invalid body")
    }

    const tokenResponse = await request(`${OPENAI_ISSUER}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code.authorization_code,
        redirect_uri: OPENAI_DEVICE_REDIRECT_URI,
        client_id: OPENAI_CLIENT_ID,
        code_verifier: code.code_verifier,
      }).toString(),
    })
    if (!tokenResponse.ok) {
      throw new ProviderAuthError("provider_auth_callback_failed", `Token exchange failed: ${tokenResponse.status}`)
    }

    const tokens = await tokenResponse.json() as Partial<TokenResponse>
    if (!tokens.access_token || !tokens.refresh_token) {
      throw new ProviderAuthError("provider_auth_callback_failed", "Token exchange returned an invalid body")
    }
    return tokens as TokenResponse
  }
}

function parseJwtClaims(token: string | undefined): Record<string, unknown> | undefined {
  if (!token) return
  const parts = token.split(".")
  if (parts.length !== 3 || !parts[1]) return
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString()) as Record<string, unknown>
  } catch {
    return
  }
}

function extractAccountIdFromClaims(claims: Record<string, unknown> | undefined) {
  if (!claims) return
  if (typeof claims.chatgpt_account_id === "string") return claims.chatgpt_account_id
  const openai = claims["https://api.openai.com/auth"]
  if (openai && typeof openai === "object" && "chatgpt_account_id" in openai) {
    const account = openai.chatgpt_account_id
    if (typeof account === "string") return account
  }
  const organizations = claims.organizations
  if (Array.isArray(organizations)) {
    const first = organizations[0]
    if (first && typeof first === "object" && "id" in first && typeof first.id === "string") return first.id
  }
}

function extractAccountId(tokens: TokenResponse) {
  return extractAccountIdFromClaims(parseJwtClaims(tokens.id_token))
    ?? extractAccountIdFromClaims(parseJwtClaims(tokens.access_token))
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
