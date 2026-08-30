import type { OnboardingCredential } from "./state"

export type CloudShareBlock = {
  /** Why this credential cannot go to the cloud, in the user's terms. */
  reason: string
  /** What to do instead. */
  repair?: string
}

/**
 * The harness bindings Claude Code's own login is discovered under. A row with
 * one of these provider ids and `kind: "oauth_token"` is the machine's Keychain
 * (or `CLAUDE_CODE_OAUTH_TOKEN`) login — see the server's `claudeOAuthItem`,
 * which is its only producer.
 */
const claudeSubscriptionProviders = ["claude-sdk", "anthropic"]

/**
 * Whether a credential is model/agent auth at all.
 *
 * Mirrors the server's fanout allowlist: only bare-provider `api_key`,
 * `oauth_token`, and `subscription_session` rows ever reach a sandbox's runtime
 * config. A `sandbox_driver` token provisions EVERY sandbox and must never sit
 * inside one, and `integration:`/`channel:` rows reach their consumers through
 * their own gated paths. Offering any of them here would promise a share that
 * the server would then decline to carry.
 */
export function isCloudRelevantCredential(credential: OnboardingCredential) {
  return credential.kind !== "sandbox_driver" && !credential.providerId.includes(":")
}

/**
 * Whether the cloud can be given this credential and keep it working.
 *
 * The one exclusion is a discovered Claude Code login. Claude Code owns that
 * token: it lives ~8 hours, Claude Code refreshes it in a store we cannot write
 * back to, and the refresh token is single-use — so a copy spent in a sandbox
 * either dies within the day or logs the user out of their own Claude Code. A
 * `claude setup-token` value is the same user's grant minted for exactly this
 * purpose and arrives as an `api_key`, so it is unaffected.
 *
 * Codex OAuth is deliberately NOT excluded: its tokens live in `~/.codex` files
 * the server rewrites atomically after every refresh, so the user's own CLI is
 * never stranded holding a superseded token.
 *
 * Discriminates on kind and provider only. `source` is on the wire but is not a
 * provenance field — both save paths derive it from the requested SCOPE, so a
 * discovered Claude login saved shared and a pasted setup-token saved shared
 * are both `managed`. It collides on exactly the pair this rule must separate.
 */
export function isCloudShareable(credential: OnboardingCredential) {
  return isCloudRelevantCredential(credential) && !cloudShareBlock(credential)
}

/**
 * Why a cloud-relevant credential cannot be shared, when the user deserves to
 * be told. Absent for a credential that shares fine, and absent for one that
 * was never part of this conversation — `isCloudRelevantCredential` decides
 * that, and those rows are not rendered at all rather than explained away.
 */
export function cloudShareBlock(credential: OnboardingCredential): CloudShareBlock | undefined {
  if (!isClaudeSubscriptionLogin(credential)) return
  return {
    reason: "Claude Code owns this login and refreshes it every few hours, so a copy in the cloud stops working — and refreshing it there can sign you out here.",
    repair: "Run `claude setup-token` and paste that token to give cloud agents their own Claude access.",
  }
}

/**
 * ASSUMPTION this rule rests on: `kind` records how a secret was ENTERED, not
 * what it is. A discovered Keychain/file login is saved as `oauth_token`; a
 * pasted `sk-ant-oat01-…` setup-token goes through the API-key path and is
 * saved as `api_key` — even though both are Anthropic OAuth material. That
 * asymmetry is the entire discriminator. If the server ever reclassifies pasted
 * setup-tokens as `oauth_token`, this predicate would silently block the only
 * cloud path Claude has; `credential-sharing.test.ts` pins the api_key case so
 * that change fails a test instead of a user's setup.
 *
 * A row with no `kind` came from a server that predates the field. For the
 * Claude harness bindings that ambiguity resolves closed: discovery is the only
 * thing that writes `claude-sdk` rows without an explicit kind, and
 * offering the wrong one costs the user their local login.
 */
function isClaudeSubscriptionLogin(credential: OnboardingCredential) {
  if (!claudeSubscriptionProviders.includes(credential.providerId)) return false
  if (credential.kind === "oauth_token") return true
  return credential.kind === undefined && credential.providerId !== "anthropic"
}
