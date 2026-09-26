import type { WorkspaceScope } from "./scope.js"
import { asNumber as num, asRecord as rec } from "@claxedo/helpers/guards"

export type TokenUsage = Readonly<{
  input: number
  output: number
  reasoning: number
  cache: Readonly<{ read: number; write: number }>
}>

export type SessionSummary = Readonly<{
  id: string
  title?: string
  parentID?: string
  directory: string
  createdAt: number
  updatedAt: number
  idleAt?: number
  outcome?: "succeeded" | "failed" | "interrupted"

  tokens?: TokenUsage
}>

export function tokenUsage(input: unknown): TokenUsage | undefined {
  const row = rec(input)
  const cache = rec(row?.cache)
  const prompt = num(row?.input)
  const output = num(row?.output)
  const reasoning = num(row?.reasoning)
  const read = num(cache?.read)
  const write = num(cache?.write)
  if (prompt === undefined || output === undefined || reasoning === undefined || read === undefined || write === undefined) {
    return undefined
  }
  return { input: prompt, output, reasoning, cache: { read, write } }
}

export type SessionPage = Readonly<{
  sessions: readonly SessionSummary[]
  previous?: string
  next?: string
}>

export type PromptAttachment = Readonly<{

  ref: string
  name?: string
  description?: string
  mention?: Readonly<{ start: number; end: number; text: string }>
}>

export type PromptRequest = Readonly<{
  text: string

  id?: string
  files?: readonly PromptAttachment[]
  agents?: readonly PromptAttachment[]
  skills?: readonly PromptAttachment[]

  metadata?: JsonObject

  delivery?: "steer" | "queue"
  resume?: boolean
}>

export type AdmittedMessage = Readonly<{
  id: string
  sessionID: string
  createdAt: number
  text: string
  delivery?: "steer" | "queue"
}>

export type SessionMessage = Readonly<{
  id: string
  type: string
  createdAt: number

  text?: string

  agent?: string
  model?: Readonly<{ providerID: string; id: string }>
  content?: readonly unknown[]
  finish?: string
  error?: unknown
  metadata?: Readonly<Record<string, unknown>>
  completedAt?: number
}>

export type MessagePage = Readonly<{
  messages: readonly SessionMessage[]
  previous?: string
  next?: string
}>

export type ForkBoundary = Readonly<{ type: "before"; messageID: string }> | Readonly<{ type: "through" }>

export type OpenCodeSessionPort = Readonly<{
  create(scope: WorkspaceScope, input?: { id?: string; title?: string }): Promise<SessionSummary>
  get(scope: WorkspaceScope, sessionID: string): Promise<SessionSummary>
  list(scope: WorkspaceScope, input?: { limit?: number; cursor?: string }): Promise<SessionPage>
  rename(scope: WorkspaceScope, sessionID: string, title: string): Promise<void>
  remove(scope: WorkspaceScope, sessionID: string): Promise<void>
  fork(scope: WorkspaceScope, sessionID: string, boundary: ForkBoundary): Promise<SessionSummary>
  switchAgent(scope: WorkspaceScope, sessionID: string, agent: string): Promise<void>

  switchModel(scope: WorkspaceScope, sessionID: string, model: { providerID: string; modelID: string; variant?: string }): Promise<void>

  prompt(scope: WorkspaceScope, sessionID: string, request: PromptRequest): Promise<AdmittedMessage>
  command(
    scope: WorkspaceScope,
    sessionID: string,
    input: { command: string; text?: string; delivery?: "steer" | "queue" },
  ): Promise<void>
  interrupt(scope: WorkspaceScope, sessionID: string, options?: { continue?: boolean }): Promise<void>
  wait(scope: WorkspaceScope, sessionID: string): Promise<void>

  revertTo(scope: WorkspaceScope, sessionID: string, messageID: string, options?: { files?: boolean }): Promise<void>

  clearRevert(scope: WorkspaceScope, sessionID: string): Promise<void>

  messages(
    scope: WorkspaceScope,
    sessionID: string,
    page?: { limit?: number; cursor?: string; order?: "asc" | "desc" },
  ): Promise<MessagePage>
}>

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject
export type JsonObject = { [key: string]: JsonValue }
