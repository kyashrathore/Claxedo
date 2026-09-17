/** Browser-facing Claxedo DTOs the app reads off claxedo-server routes; the workspace runtime's own live in `@claxedo/workspace-runtime/client`. */

import type { AgentPresentationSession } from "@claxedo/agent-runtime-contract"

export type ClaxedoProject = {
  id: string
  worktree: string
  vcs?: "git"
  name?: string
  icon?: { url?: string; override?: string; color?: string }
  commands?: { start?: string }
  // The embedded OpenCode engine's `project.updated` payload carries neither:
  // it sends `{ id, worktree, vcs }`.
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

export type ClaxedoProviderAuthorization = {
  url: string
  method: "auto" | "code"
  instructions: string
}

export type ClaxedoProviderModel = {
  id: string
  providerID: string
  api: { id: string; url: string; npm: string }
  name: string
  family?: string
  capabilities: {
    temperature: boolean
    reasoning: boolean
    attachment: boolean
    toolcall: boolean
    input: { text: boolean; audio: boolean; image: boolean; video: boolean; pdf: boolean }
    output: { text: boolean; audio: boolean; image: boolean; video: boolean; pdf: boolean }
    interleaved: boolean | { field: "reasoning" | "reasoning_content" | "reasoning_details" }
  }
  cost: {
    input: number
    output: number
    cache: { read: number; write: number }
    [key: string]: unknown
  }
  limit: { context: number; input?: number; output: number }
  status: "alpha" | "beta" | "deprecated" | "active"
  options: Record<string, unknown>
  headers: Record<string, string>
  release_date: string
  variants?: Record<string, Record<string, unknown>>
}

export type ClaxedoProvider = {
  id: string
  name: string
  source: "env" | "config" | "custom" | "api"
  env: string[]
  key?: string
  options: Record<string, unknown>
  models: Record<string, ClaxedoProviderModel>
}

export type ClaxedoProviderList = {
  all: ClaxedoProvider[]
  default: Record<string, string>
  connected: string[]
}

export type ClaxedoProviderAuthMethod = {
  type: "oauth" | "api" | "token"
  /** For `token`: the terminal command that prints the token to paste. */
  command?: string
  // Optional because the auth catalog does not always name a method, and the
  // connect form already renders `label ?? ""` — the DTO was the only place
  // claiming it was guaranteed.
  label?: string
  prompts?: Array<
    | { type: "text"; key: string; message: string; placeholder?: string; when?: { key: string; op: "eq" | "neq"; value: string } }
    | { type: "select"; key: string; message: string; options: Array<{ label: string; value: string; hint?: string }>; when?: { key: string; op: "eq" | "neq"; value: string } }
  >
}

export type ClaxedoProviderAuth = Record<string, ClaxedoProviderAuthMethod[]>

/** Workspace-operational events consumed by browser surfaces. */
export type ClaxedoWorkspaceEvent =
  | { id?: string; type: "file.watcher.updated"; properties: { file: string; event?: string } }
  | { id?: string; type: "project.updated"; properties: { info: ClaxedoProject } }
  | { id?: string; type: "vcs.branch.updated"; properties: { branch?: string } }
  | { id?: string; type: "global.disposed"; properties: Record<string, unknown> }
  | { id?: string; type: "session.deleted"; properties: { info: AgentPresentationSession } }
  | { id?: string; type: "session.share.changed"; properties: { sessionID: string; share?: { url: string } } }
  | { id?: string; type: "pty.created"; properties: { info: { id: string; sessionId?: string; createRequestId?: string; title?: string; cwd?: string } } }
  | { id?: string; type: "pty.updated"; properties: { info: { id: string; sessionId?: string; createRequestId?: string; title?: string; cwd?: string } } }
  | { id?: string; type: "pty.exited"; properties: { id: string; exitCode?: number } }
  | { id?: string; type: "pty.deleted"; properties: { id: string } }
