import type {
  Command,
  LspStatus,
  McpStatus,
  Message,
  Part,
  Project,
  ProviderListResponse,
  Session,
  Todo,
  VcsInfo,
} from "@opencode-ai/sdk/v2/client"
import type { WorkspaceRuntimeSnapshot } from "../query/runtime"
import type { PanePreferenceKind, PanePreferenceStorage } from "../../pane/store/pane-preferences"

export type SessionMessageRow = {
  info: Message
  parts?: Part[]
}

export type SessionMessagesPage = {
  data?: SessionMessageRow[]
  response: Response
}

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
  getVcs: (input: { directory: string }) => Promise<VcsInfo | undefined>
  getMcpStatus: (input: { directory: string }) => Promise<Record<string, McpStatus>>
  getLspStatus: (input: { directory: string }) => Promise<LspStatus[]>
}

export type SessionBackend = {
  usesScopedTransport: (sessionID: string | undefined) => boolean
  getSession: (input: { directory: string; sessionID: string }) => Promise<{ data?: Session }>
  listMessages: (input: {
    directory: string
    sessionID: string
    limit: number
    before?: string
  }) => Promise<SessionMessagesPage>
  listTodos: (input: { directory: string; sessionID: string }) => Promise<{ data?: Todo[] }>
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
