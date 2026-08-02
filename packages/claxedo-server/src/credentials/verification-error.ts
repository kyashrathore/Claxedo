/**
 * "We could not form a verdict" — an unsupported provider, an unreadable
 * secret shape, or a request that never reached the provider. Never a verdict
 * against the credential itself: an offline laptop must not render a red cross
 * against a key that is fine.
 *
 * Its own module so `verify.ts` and `sandbox-verify.ts` can both raise it
 * without importing each other. `verify.ts` re-exports it, which is where
 * every caller still imports it from.
 */
export class CredentialVerificationError extends Error {}
