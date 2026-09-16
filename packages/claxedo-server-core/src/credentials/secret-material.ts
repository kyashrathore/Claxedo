import { accountIdFromClaims, emailFromClaims } from "@claxedo/agent-runtime-contract"
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
  /** The signed-in user's address, when the login's own claims carry it. */
  email?: string
  form: "api-key" | "subscription"
}

/** Anthropic's OAuth access token; every other secret on that provider is a key. */
const OAUTH_TOKEN_PREFIX = /^sk-ant-o/i

const SUBSCRIPTION_KINDS = new Set<CredentialKind>(["oauth_token", "subscription_session"])

/**
 * Whether a row's kind alone says it is a plan login rather than a key. A
 * secret that is a subscription only by its prefix cannot be told apart without
 * reading it, so a caller that holds metadata and no secret — anything listing
 * accounts — reads a plan account as exactly these two kinds.
 */
export function isSubscriptionKind(kind: CredentialKind): boolean {
  return SUBSCRIPTION_KINDS.has(kind)
}

/**
 * The kind a row keeps once its secret has been read.
 *
 * A pasted `claude setup-token` arrives under the key field's kind, and the
 * row is what every listing that never opens the secret reads — the usage
 * snapshot and the reach marks — so a plan login stored as `api_key` is a plan
 * with no card and no windows. Only this direction is decidable: a bare secret
 * under `oauth_token` reads as a subscription whatever it looks like.
 */
export function storedCredentialKind(input: { kind: CredentialKind; secret: string }): CredentialKind {
  if (input.kind !== "api_key") return input.kind
  return credentialSecretMaterial(input)?.form === "subscription" ? "oauth_token" : "api_key"
}

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
  // A ChatGPT login often names its account only inside the `id_token` claims,
  // and the header that account id fills is what tells the backend which plan
  // the token spends. One reader for both shapes, shared with the Codex home.
  const accountId = [document.account_id, document.accountId, tokens?.account_id, oauth?.account_id]
    .map(jsonString)
    .find((item) => item !== undefined)
    ?? accountIdFromClaims(document)
  const email = emailFromClaims(document)
  return {
    token,
    ...(accountId ? { accountId } : {}),
    ...(email ? { email } : {}),
    form: "subscription",
  }
}
