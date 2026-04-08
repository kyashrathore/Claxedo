import type {
  Agent,
  Command,
  Config,
  FileDiff,
  LspStatus,
  McpStatus,
  Message,
  Part,
  Path,
  PermissionRequest,
  Project,
  ProviderListResponse,
  QuestionRequest,
  Session,
  SessionStatus,
  Todo,
  VcsInfo,
} from "@opencode-ai/sdk/v2/client"
import type { Accessor } from "solid-js"
import type { SetStoreFunction, Store } from "solid-js/store"

export type ProjectMeta = {
  name?: string
  icon?: {
    override?: string
    color?: string
  }
  commands?: {
    start?: string
  }
}

export type State = {
  status: "loading" | "partial" | "complete"
  agent: Agent[]
  command: Command[]
  project: string
  projectMeta: ProjectMeta | undefined
  icon: string | undefined
  provider_ready: boolean
  provider: ProviderListResponse
  config: Config
  path: Path
  session: Session[]
  sessionTotal: number
  session_status: {
    [sessionID: string]: SessionStatus
  }
  session_diff: {
    [sessionID: string]: FileDiff[]
  }
  todo: {
    [sessionID: string]: Todo[]
  }
  permission: {
    [sessionID: string]: PermissionRequest[]
  }
  question: {
    [sessionID: string]: QuestionRequest[]
  }
  mcp_ready: boolean
  mcp: {
    [name: string]: McpStatus
  }
  lsp_ready: boolean
  lsp: LspStatus[]
  vcs: VcsInfo | undefined
  limit: number
  message: {
    [sessionID: string]: Message[]
  }
  part: {
    [messageID: string]: Part[]
  }
  session_agent: {
    [sessionID: string]: string
  }
  session_config: {
    [sessionID: string]: unknown[]
  }
  session_usage: {
    [sessionID: string]: { contextSize: number; contextUsed: number; cost?: { amount: number; currency: string } }
  }
}

export type VcsCache = {
  store: Store<{ value: VcsInfo | undefined }>
  setStore: SetStoreFunction<{ value: VcsInfo | undefined }>
  ready: Accessor<boolean>
}

export type MetaCache = {
  store: Store<{ value: ProjectMeta | undefined }>
  setStore: SetStoreFunction<{ value: ProjectMeta | undefined }>
  ready: Accessor<boolean>
}

export type IconCache = {
  store: Store<{ value: string | undefined }>
  setStore: SetStoreFunction<{ value: string | undefined }>
  ready: Accessor<boolean>
}

export type SessionCacheValue = {
  at: number
  limit: number
  total: number
  session: Session[]
}

export type SessionCache = {
  store: Store<{ value: SessionCacheValue }>
  setStore: SetStoreFunction<{ value: SessionCacheValue }>
  ready: Accessor<boolean>
}

export type ChildOptions = {
  bootstrap?: boolean
}

export type DirState = {
  lastAccessAt: number
}

export type EvictPlan = {
  stores: string[]
  state: Map<string, DirState>
  pins: Set<string>
  max: number
  ttl: number
  now: number
}

export type DisposeCheck = {
  directory: string
  hasStore: boolean
  pinned: boolean
  booting: boolean
  loadingSessions: boolean
}

export type RootLoadArgs = {
  directory: string
  limit: number
  list: (query: { directory: string; roots: true; limit?: number }) => Promise<{ data?: Session[] }>
}

export type RootLoadResult = {
  data?: Session[]
  limit: number
  limited: boolean
}

export type GlobalSessionItem = {
  id: string
  title: string
  directory: string
  projectID: string
  parentID?: string
  rootID?: string
  tags: string[]
  attachments: Array<{ kind: string; targetID: string }>
  environment?: { kind?: string; provider?: string }
  git?: { repo?: string; branch?: string; remote?: string }
  archived?: boolean
  time: { created: number; updated: number }
}

export type WorkspaceGroup = {
  directory: string
  projectID: string
  sessions: GlobalSessionItem[]
  hasMore: boolean
  total: number
  nextCursor?: number
}

export type GlobalSessionState = {
  global: GlobalSessionItem[]
  globalState: { hasMore: boolean; loading: boolean; cursor?: number }
  byProject: Record<string, GlobalSessionItem[]>
  projectState: Record<string, { hasMore: boolean; loading: boolean; cursor?: number }>
  byWorkspace: Record<string, WorkspaceGroup>
  workspaceState: Record<string, { hasMore: boolean; loading: boolean; cursor?: number }>
  workspaceOrder: string[]
  loading: boolean
  loaded: boolean
  initialCursor?: number
}

export const MAX_DIR_STORES = 30
export const DIR_IDLE_TTL_MS = 20 * 60 * 1000
export const SESSION_RECENT_WINDOW = 4 * 60 * 60 * 1000
export const SESSION_RECENT_LIMIT = 50
