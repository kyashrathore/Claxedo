/**
 * The session stores a composition that serves no sessions still has to supply.
 *
 * `ControlPlaneServices` requires a projection store and a durable session log,
 * because a composition that serves sessions cannot be allowed to forget them.
 * A composition that serves NONE — the hosted Worker control plane, the workerd
 * auth spike — used to satisfy that requirement by asserting an object it never
 * populated, so a stray call surfaced as `undefined is not a function` with
 * nothing to say about which store was reached or why it was empty.
 *
 * These fail closed and say so instead. They live in this leaf module, with no
 * imports beyond the two port types, so a composition can reach them without
 * dragging a composition graph behind them.
 *
 * Written out member by member rather than produced by a `Proxy` behind a
 * `<T extends object>` the caller picks: the proxy answered ANY property with a
 * thrower, so it satisfied the port by assertion and a member added to
 * `ProjectionStore` would never have been noticed here. These fail the
 * typecheck instead.
 */
import type { DurableSessionLog } from "@claxedo/server-core/platform/auth/durable-session-log"
import type { ProjectionStore } from "./projection-store"

function unavailable(member: string): never {
  throw new Error(`${member} is not available in this control-plane composition`)
}

export const UNUSED_PROJECTION_STORE: ProjectionStore = {
  sync_session_meta: () => unavailable("Session projection store"),
  sync_session_metas: () => unavailable("Session projection store"),
  sync_session_messages: () => unavailable("Session projection store"),
  put_session_meta: () => unavailable("Session projection store"),
  delete_session_meta: () => unavailable("Session projection store"),
  session_meta: () => unavailable("Session projection store"),
  session_metas: () => unavailable("Session projection store"),
  list_session_metas: () => unavailable("Session projection store"),
  tagged_session_metas: () => unavailable("Session projection store"),
  read_session_messages: () => unavailable("Session projection store"),
  read_session_max_event_ordinal: () => unavailable("Session projection store"),
}

export const UNUSED_DURABLE_SESSION_LOG: DurableSessionLog = {
  persist_message_event: () => unavailable("Durable session log"),
}
