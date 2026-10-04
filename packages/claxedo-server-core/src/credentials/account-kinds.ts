import type { CredentialKind, CredentialMetadata } from "./types"

/**
 * Fanout ALLOWLIST. The harness auth fanout exists for ONE purpose: let the
 * agent inside a sandbox use the user's own model/AI-provider auth — the same
 * Claude/Codex/Cursor/OpenAI subscription or API key they use locally. So a
 * credential fans out into a sandbox runtime-config snapshot only when it is
 * model/agent-provider auth: kind ∈ {api_key, oauth_token,
 * subscription_session} AND a bare (non-namespaced) provider id.
 *
 * Everything else stays server-side and reaches its consumer another way:
 *  - `kind: "sandbox_driver"` (Vercel/Cloudflare/…): provisioning
 *    credentials the DRIVER injects natively; the driver API token controls
 *    EVERY sandbox and must never sit in a sandbox's own config. Resolved for
 *    provisioning via `config.sandbox_driver`, never through this fanout.
 *  - `integration:*` (connections) and `channel:*` (channel state): reach
 *    consumers only through their own gated paths (the connections token
 *    endpoint, the channel runtime).
 *
 * Allowlist by design, not a denylist: a future non-model credential kind is
 * fenced by the kind check, and a future namespaced id by the id check, so a
 * new credential type cannot silently start leaking into sandboxes.
 */
export const PROVIDER_AUTH_KINDS = ["api_key", "oauth_token", "subscription_session"] as const satisfies readonly CredentialKind[]
const FANOUT_ELIGIBLE_KINDS = new Set<CredentialKind>(PROVIDER_AUTH_KINDS)

export function fanoutEligibleAuth(kind: CredentialKind, providerId: string): boolean {
  return FANOUT_ELIGIBLE_KINDS.has(kind) && !providerId.includes(":")
}

/** Whether a stored row is an account a harness runs on, rather than a driver, connection or channel secret. */
export function fanoutEligible(cred: CredentialMetadata): boolean {
  return fanoutEligibleAuth(cred.kind, cred.provider_id)
}
