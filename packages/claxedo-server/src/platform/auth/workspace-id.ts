/**
 * Workspace id minting — the ONE generator both control-plane variants use.
 *
 * Ids used to be `` `ws_${Date.now().toString(36)}` `` in BOTH the hosted
 * Worker route (`routes/hosted-workspace.ts`) and the local Node route
 * (`routes/workspace.ts`): a bare millisecond timestamp with no random
 * component. Two consequences, both real:
 *
 *  1. **Guessable.** An attacker who knows roughly when a victim created a
 *     workspace can enumerate the whole plausible window — a few thousand
 *     candidates for a minute of wall clock — and hit the victim's id exactly.
 *     Chained with a workspace-authority create that has no existing-row guard,
 *     that is a targeted collision, not a probabilistic one.
 *  2. **Leaky.** The id IS the creation time, readable by anyone who sees it.
 *
 * The fix is randomness, not the removal of the timestamp: a sortable time
 * prefix is genuinely useful (log correlation, rough age at a glance) and was
 * never the weakness. So the shape is `ws_<base36 millis>_<random>`.
 *
 * Cross-runtime by construction. This module touches only the global `crypto`
 * object (Web Crypto), which exists in Node >= 19 and in Cloudflare Workers, so
 * the same generator serves the Worker bundle and the Node server without
 * `node:crypto` ever entering the Worker's import graph
 * (`worker.import-graph.test.ts` enforces that). It is also storage-agnostic,
 * as everything outside `authority/adapters/*` must be (architecture).
 */

/**
 * Crockford-style base32: lowercase, and without `i`/`l`/`o`/`u` so an id read
 * off a screen or a URL cannot be mistyped into a different valid id. Exactly
 * 32 symbols, which is what makes the `& 31` mapping below unbiased.
 */
const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"

/**
 * Symbols of randomness per id: 16 x 5 bits = 80 bits.
 *
 * Sized by a LENGTH BUDGET, not by wishful maximalism. Workspace ids are
 * embedded in driver-side resource names that have real ceilings, and the
 * tightest two set the cap at ~28 characters total:
 *
 *  - `drivers/daytona.ts` `daytonaSecretName` builds
 *    `claxedo-<workspaceId>-<secretName>` with no truncation. The longest
 *    secret name in the tree is `CLAXEDO_GITHUB_CLONE_AUTH` (25), so
 *    8 + 28 + 1 + 25 = 62 — just inside a 63-character name limit.
 *  - `drivers/exe.ts` `exeWorkspaceName` slices the sanitized id to 30
 *    characters for its reattach slug. A 28-character id sanitizes to 28 and
 *    is never truncated, so the slug stays a faithful function of the id.
 *
 * 80 bits is not a compromise on the security property: an attacker who knows
 * the exact creation millisecond still faces 2^80 (~1.2e24) candidates over an
 * authenticated HTTP API. The weakness Chain A describes was the total absence
 * of randomness, and any cryptographic amount closes it.
 */
const RANDOM_SYMBOLS = 16

/**
 * A URL-safe random string from cryptographic randomness.
 *
 * One byte per symbol, masked to its low 5 bits. 256 is an exact multiple of
 * 32, so the mask is uniform — no modulo bias, and no rejection loop to get it
 * wrong. Spending 8 bits of entropy to emit 5 is a trade this path can easily
 * afford.
 */
export function randomIdSuffix(symbols: number = RANDOM_SYMBOLS): string {
  const bytes = new Uint8Array(Math.max(1, symbols))
  crypto.getRandomValues(bytes)
  let out = ""
  for (const byte of bytes) out += ID_ALPHABET[byte & 31]
  return out
}

/** The exact length `newWorkspaceId` produces this century. Asserted in tests. */
export const WORKSPACE_ID_LENGTH = 3 + 8 + 1 + RANDOM_SYMBOLS

/**
 * Mint a workspace id: `ws_<base36 millis>_<80 bits of base32 randomness>`.
 *
 * 28 characters, `[a-z0-9_]` only, so it stays safe in URLs, DNS labels,
 * container/sandbox names, relay room names, and storage keys. Base36
 * milliseconds are a fixed 8 characters from 2004 to 2059, so the ids also stay
 * lexicographically ordered by creation time — which is why keeping the
 * timestamp costs nothing. The suffix is what makes them unguessable.
 */
export function newWorkspaceId(now: number = Date.now()): string {
  return `ws_${now.toString(36)}_${randomIdSuffix()}`
}

/**
 * Shape check for a minted workspace id.
 *
 * Deliberately NOT used to validate ids arriving on requests: user-hosted
 * workspaces carry caller-chosen ids (`registerLocalForSharing`), so rejecting
 * anything that does not match this pattern would break them. It exists so
 * tests and tooling can assert what this generator produces.
 */
export function isMintedWorkspaceId(value: string): boolean {
  return /^ws_[0-9a-z]+_[0-9a-hjkmnp-tv-z]{16}$/.test(value)
}
