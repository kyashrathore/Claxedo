import type { CredentialHealth, CredentialMetadata } from "./types"

export type { CredentialHealth } from "./types"

export class CredentialVerificationError extends Error {}

export async function verifyCredential(
  credential: CredentialMetadata,
  secret: string,
  options: { fetch?: typeof fetch; now?: () => number } = {},
): Promise<CredentialHealth> {
  const now = options.now ?? Date.now
  if (credential.expires_at !== null && credential.expires_at !== undefined && credential.expires_at <= now()) {
    return "expired"
  }
  const anthropic = ["anthropic", "claude-acp", "claude-sdk"].includes(credential.provider_id)
  const openai = ["openai", "codex-acp", "codex-app-server"].includes(credential.provider_id)
  if (!anthropic && !openai) {
    throw new CredentialVerificationError("Credential provider does not support verification")
  }
  const auth = verificationAuth(credential, secret)
  if (!auth) throw new CredentialVerificationError("Credential secret has an unsupported shape")
  const codex = openai && credential.kind === "oauth_token"
  const probe = providerProbe(credential, auth, anthropic, codex)
  const response = await (options.fetch ?? globalThis.fetch)(probe.url, probe.init).catch(() => {
    throw new CredentialVerificationError("Credential provider request failed")
  })
  if (response.ok) return "ok"
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
      body: JSON.stringify({
        model: codex ? "gpt-5.4-mini" : "gpt-4.1-nano",
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
