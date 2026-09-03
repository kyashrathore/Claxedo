/**
 * Cloudflare applies Durable Object lifecycle migrations only through a full
 * deployment. Keep that irreversible operation independent from product code:
 * the bridge serves the existing fail-closed bootstrap gate while adding the
 * LiveSyncRoom class and v1 namespace to this release train.
 */
export { default } from "./better-auth-d1-bootstrap-gate.cf"
export { LiveSyncRoom } from "./live-sync-room.cf"
