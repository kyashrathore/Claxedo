type Model = {
  id: string
  name: string
  release_date: string
  attachment: boolean
  reasoning: boolean
  temperature: boolean
  tool_call: boolean
  limit: {
    context: number
    output: number
  }
  cost: {
    input: number
    output: number
  }
  options: Record<string, unknown>
}

type Provider = {
  id: string
  name: string
  env: string[]
  models: Record<string, Model>
}

export type DemoProject = {
  id: string
  worktree: string
  name: string
  sandboxes?: string[]
  time: {
    created: number
    updated: number
  }
}

export type DemoSession = {
  id: string
  slug: string
  projectID: string
  directory: string
  title: string
  version: string
  time: {
    created: number
    updated: number
  }
  summary: {
    additions: number
    deletions: number
    files: number
  }
}

type Token = {
  input: number
  output: number
  reasoning: number
  cache: {
    read: number
    write: number
  }
}

type MessageInfo = {
  id: string
  sessionID: string
  role: "user" | "assistant"
  time: Record<string, number>
  agent: string
  model?: {
    providerID: string
    modelID: string
  }
  modelID?: string
  providerID?: string
  parentID?: string
  mode?: string
  path?: {
    cwd: string
    root: string
  }
  cost?: number
  tokens?: Token
  system?: string
  variant?: string
}

export type DemoPart = {
  id: string
  sessionID: string
  messageID: string
  type: string
  text?: string
  callID?: string
  tool?: string
  state?: {
    status: string
    input?: Record<string, unknown>
    output?: unknown
    title?: string
    metadata?: Record<string, unknown>
    time?: {
      start: number
      end: number
    }
  }
}

export type DemoMessage = {
  info: MessageInfo
  parts: DemoPart[]
}

export type DemoDiff = {
  file: string
  status: string
  additions: number
  deletions: number
  before: string
  after: string
}

export type DemoDocument = {
  id: string
  project_id: string
  display_name: string
  origin_kind: "managed" | "repository"
  placement_kind: "local"
  placement_id: string
  managed_relative_path: string | null
  repository_id: string | null
  workspace_id: string | null
  repository_relative_path: string | null
  branch: string | null
  status: string
  session_id: string | null
  archived_at: string | null
  created_at: string
  updated_at: string
  last_opened_at: string | null
  last_known_file_version: string
  markdown: string
  modifiedAt: number
}

export type DemoPty = {
  id: string
  title: string
  command: string
  args: string[]
  cwd: string
  status: string
  pid: number
}

export type DemoPreview = {
  terminalId: string
  surfaceId?: string
  workspaceId?: string
  provider?: string
  sessionId?: string | null
  transcriptPath?: string | null
  refName?: string
  prompt?: string
  lastAssistantMessage?: string
  eventType?: string
  updatedAt: number
}

type FileNode = {
  name: string
  path: string
  absolute: string
  type: "file" | "directory"
  ignored: boolean
}

type FileStatus = {
  path: string
  added: number
  removed: number
  status: string
}

export type DemoFixtures = {
  globalConfig: Record<string, unknown>
  providerAuth: Record<string, unknown>
  provider: {
    all: Provider[]
    connected: string[]
    default: {
      id: string
      model: string
    }
  }
  agents: Array<{
    id: string
    name: string
    description: string
  }>
  config: {
    provider: {
      id: string
      model: string
    }
    agent: {
      id: string
    }
  }
  projects: DemoProject[]
  projectInfo: Record<string, { id: string; name: string; worktree: string }>
  sessions: DemoSession[]
  sessionMessages: Record<string, DemoMessage[]>
  sessionDiffTargets: {
    defaultRef: string
    candidates: string[]
  }
  sessionDiffs: Record<string, DemoDiff[]>
  documents: DemoDocument[]
  ptys: DemoPty[]
  ptyPreview: Record<string, DemoPreview>
  fileSearch: string[]
  fileTree: Record<string, FileNode[]>
  fileContent: {
    content: string
    language: string
  }
  fileStatus: FileStatus[]
  permissions: unknown[]
  questions: unknown[]
  skills: unknown[]
  commands: unknown[]
  mcp: Record<string, unknown>
  vcs: {
    branch: string
  }
  path: {
    home: string
    state: string
    config: string
  }
}

const PATH = "/demo/fixtures.json"
let cache: Promise<DemoFixtures> | undefined

function clone<T>(value: T): T {
  return structuredClone(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object"
}

function isDemoFixtures(value: unknown): value is DemoFixtures {
  if (!isRecord(value)) return false
  return (
    isRecord(value.provider) &&
    isRecord(value.config) &&
    Array.isArray(value.projects) &&
    isRecord(value.projectInfo) &&
    Array.isArray(value.sessions) &&
    isRecord(value.sessionMessages) &&
    isRecord(value.sessionDiffs) &&
    Array.isArray(value.documents) &&
    Array.isArray(value.ptys) &&
    isRecord(value.ptyPreview)
  )
}

async function raw() {
  if (!cache) {
    cache = fetch(PATH, { cache: "no-store" }).then(async (res) => {
      if (!res.ok) {
        throw new Error(`Failed to load demo fixtures: ${res.status}`)
      }
      const data: unknown = await res.json()
      if (!isDemoFixtures(data)) throw new Error("Demo fixtures are malformed")
      return data
    })
  }
  return cache
}

export async function loadFixtures() {
  return clone(await raw())
}
