import type {
  Command,
  LspStatus,
  McpStatus,
  Message,
  Part,
  Project,
  ProviderListResponse,
  Todo,
  VcsInfo,
} from "@opencode-ai/sdk/v2/client"
import type { WorkspaceRuntimeSnapshot } from "../query/runtime"
import type { PanePreferenceKind, PanePreferenceStorage } from "../../pane/store/pane-preferences"
import type { SessionRef } from "../../shell/identity/session-ref"
import type { ClaxedoSession } from "./session-types"

type TransportCapabilities = {
  transport: "claude-acp" | "codex-acp" | "cursor-acp" | "claude-sdk" | "codex-app-server" | "opencode"
  abort: boolean
  reconnect: boolean
  replay: boolean
  permissions: boolean
  questions: boolean
  todos: boolean
  commands: boolean
  fork: boolean
  revert: boolean
  unrevert: boolean
  configOptions: boolean
}

export type SessionMessageRow = {
  info: Message
  parts?: Part[]
}

export type SessionMessagesPage = {
  data?: SessionMessageRow[]
  maxEventOrdinal: number
  response: Response
}

export type SessionTransportCapabilities = TransportCapabilities

export type ShellBackend = {
  listProjects: () => Promise<Project[] | undefined>
  listProviders: () => Promise<ProviderListResponse | undefined>
  listCommands: (input: { directory: string }) => Promise<Command[] | undefined>
}

export type WorkspaceRuntimeBackend = {
  resolveWorkspace: (input: {
    directory?: string
    workspaceId?: string
    create?: boolean
  }) => Promise<WorkspaceRuntimeSnapshot | null>
  ensureWorkspace: (input: {
    directory?: string
    workspaceId?: string
  }) => Promise<WorkspaceRuntimeSnapshot>
  getVcs: (input?: { directory?: string }) => Promise<VcsInfo | undefined>
  getMcpStatus: (input?: { directory?: string }) => Promise<Record<string, McpStatus>>
  getLspStatus: (input?: { directory?: string }) => Promise<LspStatus[]>
}

export type SessionBackend = {
  usesScopedTransport: (sessionID: string | undefined, directory?: string) => boolean
  getSession: (input: { directory: string; sessionID: string; sessionRef?: SessionRef }) => Promise<{ data?: ClaxedoSession }>
  getCapabilities: (input: {
    directory: string
    sessionID?: string
    sessionRef?: SessionRef
  }) => Promise<SessionTransportCapabilities>
  listMessages: (input: {
    directory: string
    sessionID: string
    sessionRef?: SessionRef
    limit: number
    before?: string
  }) => Promise<SessionMessagesPage>
  listTodos: (input: { directory: string; sessionID: string; sessionRef?: SessionRef }) => Promise<{ data?: Todo[] }>
}

export type PanePrefsBackend = {
  storage: () => PanePreferenceStorage
  getMap: (kind: PanePreferenceKind) => Record<string, string>
  setMap: (kind: PanePreferenceKind, value: Record<string, string>) => void
}

export type DataBackend = {
  shell: ShellBackend
  runtime: WorkspaceRuntimeBackend
  session: SessionBackend
  panePrefs: PanePrefsBackend
}
