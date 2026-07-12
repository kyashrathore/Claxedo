/**
 * Codex-bundle model backend for the real-pi harness.
 *
 * Where local-auth reads the server's OWN home-dir stores (local dev), this
 * resolver is fed a codex auth BUNDLE from an injected source — on a deployed
 * box that's the control plane's credential registry, populated via the
 * consent-gated `claxedo creds sync` / PUT /credentials flow. Accepted shapes:
 *
 *   - Codex CLI / registry `codex_auth` JSON:
 *     `{ tokens: { access_token, refresh_token, account_id?, id_token? }, ... }`
 *     (the registry variant may add top-level `access`/`refresh`/`expires`)
 *   - pi OAuth: `{ type: "oauth", access, refresh, expires, accountId? }`
 *
 * Refresh runs through pi-ai's openai-codex OAuth provider; rotated tokens are
 * handed back to the injected `persist` callback so the source of truth (the
 * registry) keeps the live refresh token.
 */
import { getOAuthApiKey, type OAuthCredentials } from "@mariozechner/pi-ai/oauth"
import { requirePiModel, type PiModelBackendResolver } from "./model-backend"

const CODEX_PROVIDER = "openai-codex"
const DEFAULT_CODEX_MODEL = "gpt-5.5"

export type CodexBundleBackendOptions = {
  /** Returns the raw bundle JSON (string) or object, or undefined when absent. */
  loadBundle: () => Promise<string | Record<string, unknown> | undefined> | string | Record<string, unknown> | undefined
  /** Receives rotated OAuth credentials after a refresh; owns persistence. */
  persist?: (credentials: OAuthCredentials) => Promise<void> | void
  /** Codex model id; defaults to a ChatGPT-account-supported model. */
  modelId?: string
  /** System prompt override for the central session. */
  systemPrompt?: string
}

function jwtExp(token: string | undefined): number | undefined {
  if (!token) return undefined
  const payload = token.split(".")[1]
  if (!payload) return undefined
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown }
    return typeof decoded.exp === "number" ? decoded.exp * 1000 : undefined
  } catch {
    return undefined
  }
}

/** Normalize any accepted bundle shape into pi OAuth credentials. */
export function codexBundleToOAuth(input: string | Record<string, unknown> | undefined): OAuthCredentials | undefined {
  if (!input) return undefined
  let value: Record<string, unknown>
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input)
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
      value = parsed as Record<string, unknown>
    } catch {
      return undefined
    }
  } else {
    value = input
  }
  const tokens = value.tokens && typeof value.tokens === "object" ? value.tokens as Record<string, unknown> : undefined
  const oauth = value.oauth && typeof value.oauth === "object" ? value.oauth as Record<string, unknown> : undefined
  const access = [value.access, tokens?.access_token, oauth?.access].find((item): item is string => typeof item === "string")
  const refresh = [value.refresh, tokens?.refresh_token, oauth?.refresh].find((item): item is string => typeof item === "string")
  if (!access || !refresh) return undefined
  const expires = [value.expires, oauth?.expires].find((item): item is number => typeof item === "number")
    ?? jwtExp(access)
    ?? 0
  const accountId = [value.accountId, tokens?.account_id, oauth?.account_id].find(
    (item): item is string => typeof item === "string",
  )
  return { access, refresh, expires, ...(accountId ? { accountId } : {}) }
}

/**
 * Backend resolver over an injected codex bundle source. Resolves undefined
 * (adapter falls back to tools-only) when the source has no usable bundle.
 */
export function codexBundlePiBackendResolver(options: CodexBundleBackendOptions): PiModelBackendResolver {
  return async (input) => {
    if (input.model && input.model.providerID !== CODEX_PROVIDER) return undefined
    const selected = input.model ?? { providerID: CODEX_PROVIDER, modelID: options.modelId ?? DEFAULT_CODEX_MODEL }
    const model = requirePiModel(selected)
    const bundle = await options.loadBundle()
    const credentials = codexBundleToOAuth(bundle)
    if (!credentials) return undefined
    return {
      model,
      getApiKey: async (provider: string) => {
        if (provider !== CODEX_PROVIDER) return undefined
        // Re-load per call: the registry copy may have been re-synced.
        const latest = codexBundleToOAuth(await options.loadBundle()) ?? credentials
        const result = await getOAuthApiKey(CODEX_PROVIDER, { [CODEX_PROVIDER]: latest })
        if (!result) return undefined
        if (result.newCredentials !== latest && options.persist) {
          try {
            await options.persist(result.newCredentials)
          } catch (cause) {
            console.error("[pi-bundle-auth] WARN failed to persist rotated credentials:", cause)
          }
        }
        return result.apiKey
      },
      ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
    }
  }
}

/** Chain resolvers: the first defined backend wins. */
export function firstPiModelBackend(...resolvers: PiModelBackendResolver[]): PiModelBackendResolver {
  return async (input) => {
    for (const resolver of resolvers) {
      const backend = await resolver(input)
      if (backend) return backend
    }
    return undefined
  }
}
