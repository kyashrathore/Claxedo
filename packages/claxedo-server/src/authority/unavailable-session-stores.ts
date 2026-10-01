/** Hosted sessions live in D1 authority; reaching a local store from this composition is an error. */
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
