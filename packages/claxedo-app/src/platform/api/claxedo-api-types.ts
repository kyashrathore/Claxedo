/** Browser-facing Claxedo DTOs that only the app reads; the ones the server client returns live in `@claxedo/agent-runtime-contract/server-client`. */

import type { AgentPresentationSession } from "@claxedo/agent-runtime-contract"
import type { ClaxedoProject } from "@claxedo/agent-runtime-contract/server-client"

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
  type: "oauth" | "api"
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
  | { id?: string; type: "lsp.updated"; properties: Record<string, unknown> }
  | { id?: string; type: "project.updated"; properties: { info: ClaxedoProject } }
  | { id?: string; type: "vcs.branch.updated"; properties: { branch?: string } }
  | { id?: string; type: "global.disposed"; properties: Record<string, unknown> }
  | { id?: string; type: "session.created"; properties: { info: AgentPresentationSession } }
  | { id?: string; type: "session.deleted"; properties: { info: AgentPresentationSession } }
  | { id?: string; type: "session.share.changed"; properties: { sessionID: string; share?: { url: string } } }
  | { id?: string; type: "pty.created"; properties: { info: { id: string; sessionId?: string; createRequestId?: string; title?: string; cwd?: string } } }
  | { id?: string; type: "pty.updated"; properties: { info: { id: string; sessionId?: string; createRequestId?: string; title?: string; cwd?: string } } }
  | { id?: string; type: "pty.exited"; properties: { id: string; exitCode?: number } }
  | { id?: string; type: "pty.deleted"; properties: { id: string } }
