/**
 * Stable hosted-service facade. Provider selections live under adapters/ so
 * importing the neutral contracts does not make a storage choice.
 *
 * The retired retained composition was removed; Better Auth + D1 is the
 * only profile (see `adapters/worker/better-auth-d1-compose`).
 */
export * from "./provider-neutral-hosted-services"
