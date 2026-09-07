/** Claxedo-owned DTOs the server client returns; none are generated from a harness SDK. */

export type ClaxedoProject = {
  id: string
  worktree: string
  vcs?: "git"
  name?: string
  icon?: { url?: string; override?: string; color?: string }
  commands?: { start?: string }
  // Optional because the embedded OpenCode engine's `project.updated` payload
  // carries neither: it sends `{ id, worktree, vcs }`. Readers already wrote
  // `project.sandboxes ?? []` and `project.time?.created` against that reality
  // while the DTO claimed both were guaranteed.
  time?: { created: number; updated: number; initialized?: number }
  sandboxes?: string[]
  git?: { remote?: string | null }
  workspaces?: Record<string, ClaxedoWorkspaceInventoryEntry>
}

export type ClaxedoWorkspaceInventoryEntry = {
  id?: string
  workspaceId?: string
  directory?: string
  remote_directory?: string
  remoteDirectory?: string
  kind?: "cloud" | "local" | "user-hosted"
  /**
   * How the serving process composed the session access of the runtime behind
   * this workspace, as that process declares it. `managed-private` means
   * `POST /session` there requires a control-plane reservation first.
   */
  session_authority?: "local" | "managed-private"
  status?: string
  available?: boolean
  workspace_name?: string
  workspaceName?: string
  git_remote?: string
  repo_url?: string
}

export type ClaxedoPath = {
  home: string
  state: string
  config: string
  worktree: string
  directory: string
}

export type ClaxedoVcsInfo = {
  branch?: string
  default_branch?: string
}

export type ClaxedoCommand = {
  name: string
  description?: string
  agent?: string
  model?: string
  source?: "command" | "mcp" | "skill"
  template: string
  subtask?: boolean
  hints: string[]
}

export type ClaxedoAgentProfile = {
  name: string
  description?: string
  mode: "subagent" | "primary" | "all"
  native?: boolean
  hidden?: boolean
  topP?: number
  temperature?: number
  color?: string
  permission: unknown
  model?: { modelID: string; providerID: string }
  variant?: string
  prompt?: string
  options: Record<string, unknown>
  steps?: number
}

export type ClaxedoLspStatus = {
  id: string
  // A status row identifies a server and says whether it came up; the display
  // name and project root are what the runtime knows about it, and an older
  // runtime answers `{ id, status }` alone.
  name?: string
  root?: string
  status: "connected" | "error"
}

export type ClaxedoMcpStatus =
  | { status: "connected" }
  | { status: "disabled" }
  | { status: "failed"; error: string }
  | { status: "needs_auth" }
  | { status: "needs_client_registration"; error: string }

export type ClaxedoProviderAuthorization = {
  url: string
  method: "auto" | "code"
  instructions: string
}

export type ClaxedoConfig = {
  disabled_providers?: string[]
  enabled_providers?: string[]
  model?: string
  small_model?: string
  default_agent?: string
  provider?: Record<string, { npm?: string; models?: Record<string, unknown>; [key: string]: unknown } | undefined>
  [key: string]: unknown
}
