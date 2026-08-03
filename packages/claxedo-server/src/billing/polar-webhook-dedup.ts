/**
 * The Polar webhook's key space in the durable idempotency table.
 *
 * Lives here, not next to the store adapter, because "Polar" is a billing
 * vendor decision and the control-plane core (and its storage adapters) stay
 * vendor-free — the same confinement `billing-architecture.test.ts` pins for
 * `@polar-sh/sdk` and `applyPolarState`. The store itself only ever sees an
 * opaque `cacheKey`.
 */

/**
 * Namespaced so a webhook delivery id can never collide with a session
 * operation's cache key, which is a JSON array and therefore starts with `[`.
 */
export function polarWebhookCacheKey(webhookId: string) {
  return `polar-webhook:${webhookId}`
}
