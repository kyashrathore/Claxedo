import type { AgentMessagePageInput } from "@claxedo/agent-sdk-runtime/message-page"
import type { Workspace } from "../workspace/store/index"
import type {
  SessionAttachment,
  SessionMeta,
  SessionMetaNavigationListInput,
  SessionToolSandbox,
} from "../session/meta/index"
import type { ReplayMessage, SessionMessagePage } from "../session/message-replay"

/**
 * The session half of the control-plane projection store.
 *
 * Both products read and write session metadata; only the hosted one delivers
 * channel messages. Splitting the port here is what lets a local route producer
 * name the store it actually uses without its type dragging the channel
 * delivery and run-audit modules — and, through them, the whole hosted graph —
 * into the local package's compile closure.
 *
 * The hosted `ProjectionStore` extends this with its channel methods.
 */
export type SessionProjectionStore = {
  sync_session_meta: (ws: Workspace | undefined, input: unknown) => Promise<void>
  sync_session_metas: (ws: Workspace | undefined, input: unknown[]) => Promise<void>
  sync_session_messages: (
    ws: Workspace | undefined,
    sessionID: string,
    messages: unknown[],
    options?: { maxEventOrdinal?: number },
  ) => Promise<boolean | void>
  put_session_meta: (
    sessionID: string,
    input: {
      ws?: Workspace
      workspaceID?: string | null
      directory?: string | null
      host?: "central" | "workspace"
      toolSandbox?: SessionToolSandbox | null
      model?: { providerID: string; modelID: string } | null
      title?: string | null
      parentID?: string | null
      archived?: number | null
      tags?: string[]
      attachments?: SessionAttachment[]
    },
  ) => Promise<void>
  delete_session_meta: (sessionID: string) => Promise<void>
  session_meta: (sessionID: string) => Promise<SessionMeta | undefined>
  session_metas: (input: string[]) => Promise<Map<string, SessionMeta>>
  list_session_metas: (input?: {
    workspaceID?: string
    directory?: string
    includeArchived?: boolean
  }) => Promise<SessionMeta[]>
  list_session_navigation_metas?: (input: SessionMetaNavigationListInput) => Promise<SessionMeta[]>
  tagged_session_metas: (tags: string[], input?: { includeHidden?: boolean }) => Promise<SessionMeta[]>
  source_channel_session_counts_by_week?: (input?: {
    channel?: string
    includeHidden?: boolean
  }) => Promise<Array<{ channel: string; week: string; count: number }>>
  read_session_messages: (sessionID: string) => ReplayMessage[]
  read_session_message_page?: (sessionID: string, input: AgentMessagePageInput) => SessionMessagePage
  read_session_max_event_ordinal: (sessionID: string) => number
}
