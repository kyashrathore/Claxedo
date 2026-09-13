import { jsonRecord, jsonString, parseJsonRecord } from "@claxedo/server-core/platform/runtime/lib/json"
import type { CredentialKind } from "@claxedo/server-core/credentials/types"

/**
 * What a stored credential secret actually carries, and which of a provider's
 * two auth forms it is.
 *
 * A registry row holds either a bare key or the whole login document a CLI
 * wrote (`~/.codex/auth.json`, Claude's `claudeAiOauth` block), so nothing
 * downstream can read the secret as a token without this. The form decides the
 * header a vendor accepts — Anthropic takes a subscription only as a bearer and
 * a key only in `x-api-key` — and, for OpenAI, which host serves the account at
 * all: a subscription answers on `chatgpt.com`, a key on `api.openai.com`.
 * Sending the wrong one is a 401, so the verification probe and the credential
 * broker read the shape here rather than each deciding it.
 */
export type CredentialSecretMaterial = {
  /** The value a vendor accepts as the credential. */
  token: string
  /** The account a subscription login names, when it names one. */
  accountId?: string
  form: "api-key" | "subscription"
}

/** Anthropic's OAuth access token; every other secret on that provider is a key. */
const OAUTH_TOKEN_PREFIX = /^sk-ant-o/i

const SUBSCRIPTION_KINDS = new Set<CredentialKind>(["oauth_token", "subscription_session"])

export function credentialSecretMaterial(input: {
  kind: CredentialKind
  secret: string
}): CredentialSecretMaterial | undefined {
  // Trimmed for the same reason the prefix match is: a pasted token can carry
  // surrounding whitespace, and a leading space survives into the header as
  // part of the value, so the provider is handed a token that is not the user's.
  const secret = input.secret.trim()
  if (!secret) return undefined
  const document = parseJsonRecord(secret)
  if (!document) {
    const subscription = SUBSCRIPTION_KINDS.has(input.kind) || OAUTH_TOKEN_PREFIX.test(secret)
    return { token: secret, form: subscription ? "subscription" : "api-key" }
  }
  const tokens = jsonRecord(document.tokens)
  const oauth = jsonRecord(document.oauth)
  const claude = jsonRecord(document.claudeAiOauth)
  const token = [
    document.access,
    document.access_token,
    tokens?.access_token,
    oauth?.access,
    oauth?.access_token,
    claude?.accessToken,
    claude?.access_token,
  ]
    .map(jsonString)
    .find((item) => item !== undefined)
  if (!token) return undefined
  const accountId = [document.account_id, document.accountId, tokens?.account_id, oauth?.account_id]
    .map(jsonString)
    .find((item) => item !== undefined)
  return { token, ...(accountId ? { accountId } : {}), form: "subscription" }
}
