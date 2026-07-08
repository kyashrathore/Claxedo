/**
 * Local credential resolution for the real-pi model backend.
 *
 * Resolution sources, in order:
 *   1. pi's own auth store (`~/.pi/agent/auth.json`) — OAuth or api_key entries
 *      exactly as `pi /login` writes them.
 *   2. The Codex CLI's `~/.codex/auth.json` (auth_mode "chatgpt") — translated
 *      into pi's `openai-codex` OAuth shape with `expires: 0` so the first use
 *      forces a refresh (which also re-extracts accountId).
 *   3. Environment API keys (ANTHROPIC_API_KEY / OPENAI_API_KEY / provider env
 *      via pi-ai's getEnvApiKey).
 *
 * Refreshed/rotated OAuth credentials are persisted back to pi's auth store —
 * REQUIRED for openai-codex, whose refresh tokens may rotate; losing the
 * rotated token strands the session. NOTE the shared-token caveat: refreshing
 * a token translated from ~/.codex/auth.json can invalidate the Codex CLI's
 * copy (acceptable for single-owner self-host; consent handled upstream).
 *
 * This module reads only the SERVER's own home-dir stores (the pi-native
 * local-dev path). Remote boxes receive credentials via the explicit,
 * consent-gated sync flow (W3b) — never by this module reaching elsewhere.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { getEnvApiKey, getModel } from "@mariozechner/pi-ai"
import { getOAuthApiKey, type OAuthCredentials } from "@mariozechner/pi-ai/oauth"
import type { PiModelBackend, PiModelBackendResolver } from "./model-backend"

const DEFAULT_MODELS: Record<string, string> = {
  // ChatGPT-account Codex accepts only a moving subset of registry models
  // (older gpt-5.1-codex-* slugs are rejected with 400); the Codex CLI's own
  // configured model is the reliable choice — see codexConfiguredModel().
  "openai-codex": "gpt-5.5",
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4.1",
}

/** Providers considered for automatic selection, most preferred first. */
const AUTO_PROVIDER_ORDER = ["openai-codex", "anthropic"] as const

export type LocalPiAuthOptions = {
  /** "provider/modelId" override (e.g. `CLAXEDO_PI_MODEL=openai-codex/gpt-5.1-codex-max`). */
  modelOverride?: string
  /** pi auth store path; defaults to ~/.pi/agent/auth.json. */
  piAuthPath?: string
  /** Codex CLI auth path; defaults to ~/.codex/auth.json. */
  codexAuthPath?: string
  /** System prompt override for the central session. */
  systemPrompt?: string
}

type AuthEntry = (OAuthCredentials & { type: "oauth" }) | { type: "api_key"; key: string } | Record<string, unknown>

function piAuthPath(options: LocalPiAuthOptions) {
  return options.piAuthPath ?? path.join(os.homedir(), ".pi", "agent", "auth.json")
}

function codexAuthPath(options: LocalPiAuthOptions) {
  return options.codexAuthPath ?? path.join(os.homedir(), ".codex", "auth.json")
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const raw = fs.readFileSync(file, "utf8")
    const value = JSON.parse(raw)
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

function loadAuthStore(options: LocalPiAuthOptions): Record<string, AuthEntry> {
  return (readJson(piAuthPath(options)) ?? {}) as Record<string, AuthEntry>
}

/** Translate the Codex CLI's chatgpt-mode auth bundle into pi's OAuth shape. */
function codexCliOAuth(options: LocalPiAuthOptions): (OAuthCredentials & { type: "oauth" }) | undefined {
  const value = readJson(codexAuthPath(options))
  if (!value) return undefined
  const tokens = value.tokens && typeof value.tokens === "object" ? value.tokens as Record<string, unknown> : undefined
  const access = typeof tokens?.access_token === "string" ? tokens.access_token : undefined
  const refresh = typeof tokens?.refresh_token === "string" ? tokens.refresh_token : undefined
  if (!access || !refresh) return undefined
  if (value.auth_mode !== undefined && value.auth_mode !== "chatgpt") return undefined
  // expires: 0 forces a refresh on first use; the refresh also re-derives
  // accountId from the new access token's chatgpt_account_id claim.
  return { type: "oauth", access, refresh, expires: 0 }
}

function oauthEntry(entry: AuthEntry | undefined): (OAuthCredentials & { type: "oauth" }) | undefined {
  if (!entry || typeof entry !== "object") return undefined
  const row = entry as Record<string, unknown>
  if (row.type !== "oauth") return undefined
  if (typeof row.access !== "string" || typeof row.refresh !== "string") return undefined
  return entry as OAuthCredentials & { type: "oauth" }
}

function apiKeyEntry(entry: AuthEntry | undefined): string | undefined {
  if (!entry || typeof entry !== "object") return undefined
  const row = entry as Record<string, unknown>
  return row.type === "api_key" && typeof row.key === "string" && row.key.length > 0 ? row.key : undefined
}

function persistCredentials(options: LocalPiAuthOptions, provider: string, credentials: OAuthCredentials) {
  try {
    const file = piAuthPath(options)
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const store = readJson(file) ?? {}
    store[provider] = { type: "oauth", ...credentials }
    fs.writeFileSync(file, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 })
  } catch (cause) {
    console.error("[pi-local-auth] WARN failed to persist refreshed credentials:", cause)
  }
}

function credentialsFor(options: LocalPiAuthOptions, provider: string): AuthEntry | undefined {
  const store = loadAuthStore(options)
  const entry = store[provider]
  if (entry) return entry
  if (provider === "openai-codex") return codexCliOAuth(options)
  return undefined
}

function hasUsableCredentials(options: LocalPiAuthOptions, provider: string): boolean {
  const entry = credentialsFor(options, provider)
  if (oauthEntry(entry) || apiKeyEntry(entry)) return true
  return typeof getEnvApiKey(provider) === "string"
}

/**
 * The model the Codex CLI itself is configured to use (`model = "..."` in
 * ~/.codex/config.toml). ChatGPT-account Codex serves a moving subset of
 * models, and the CLI's configured model is by definition in that subset.
 * Naive single-line parse on purpose — the global `model` key is what we want.
 */
function codexConfiguredModel(options: LocalPiAuthOptions): string | undefined {
  try {
    const file = path.join(path.dirname(codexAuthPath(options)), "config.toml")
    const raw = fs.readFileSync(file, "utf8")
    const match = raw.match(/^\s*model\s*=\s*"([^"]+)"/m)
    return match?.[1]
  } catch {
    return undefined
  }
}

function selectProviderModel(options: LocalPiAuthOptions): { provider: string; modelId: string } | undefined {
  const override = options.modelOverride?.trim()
  if (override) {
    const slash = override.indexOf("/")
    if (slash > 0) {
      return { provider: override.slice(0, slash), modelId: override.slice(slash + 1) }
    }
    console.error(`[pi-local-auth] WARN ignoring malformed model override (want provider/modelId): ${override}`)
  }
  for (const provider of AUTO_PROVIDER_ORDER) {
    if (hasUsableCredentials(options, provider)) {
      const modelId = provider === "openai-codex"
        ? codexConfiguredModel(options) ?? DEFAULT_MODELS[provider]
        : DEFAULT_MODELS[provider]
      if (modelId) return { provider, modelId }
    }
  }
  if (typeof getEnvApiKey("anthropic") === "string") return { provider: "anthropic", modelId: DEFAULT_MODELS.anthropic! }
  if (typeof getEnvApiKey("openai") === "string") return { provider: "openai", modelId: DEFAULT_MODELS.openai! }
  return undefined
}

function makeGetApiKey(options: LocalPiAuthOptions): PiModelBackend["getApiKey"] {
  return async (provider: string) => {
    const entry = credentialsFor(options, provider)
    const key = apiKeyEntry(entry)
    if (key) return key
    const oauth = oauthEntry(entry)
    if (oauth) {
      const result = await getOAuthApiKey(provider, { [provider]: oauth })
      if (result) {
        if (result.newCredentials !== oauth) persistCredentials(options, provider, result.newCredentials)
        return result.apiKey
      }
      return undefined
    }
    return getEnvApiKey(provider)
  }
}

/**
 * Build a PiModelBackendResolver over local auth stores + env. Returns
 * undefined per turn when no provider is usable — the adapter falls back to
 * its tool/echo behavior, so a credential-less box degrades instead of failing.
 */
export function localPiModelBackendResolver(options: LocalPiAuthOptions = {}): PiModelBackendResolver {
  let warnedNoBackend = false
  let warnedBadModel: string | undefined
  return () => {
    const selection = selectProviderModel(options)
    if (!selection) {
      if (!warnedNoBackend) {
        warnedNoBackend = true
        console.error(
          "[pi-local-auth] no model credentials found (pi auth store, codex CLI auth, or env keys) — central sessions run tools-only",
        )
      }
      return undefined
    }
    const candidates = [selection.modelId, DEFAULT_MODELS[selection.provider]]
      .filter((id): id is string => typeof id === "string")
      .filter((id, index, all) => all.indexOf(id) === index)
    for (const modelId of candidates) {
      try {
        const model = getModel(selection.provider as Parameters<typeof getModel>[0], modelId as never)
        return {
          model,
          getApiKey: makeGetApiKey(options),
          ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
        }
      } catch (cause) {
        const key = `${selection.provider}/${modelId}`
        if (warnedBadModel !== key) {
          warnedBadModel = key
          console.error(`[pi-local-auth] WARN model not in pi registry: ${key}:`, cause)
        }
      }
    }
    return undefined
  }
}
