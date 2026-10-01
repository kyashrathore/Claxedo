import type { SessionRef } from "@claxedo/agent-runtime-contract"

export interface SessionAttachment {
  name: string
  mimeType: string
  bytes: Uint8Array
}

export interface CreateSessionInput {
  projectId: string
  prompt: string
  title?: string
  attachments?: readonly SessionAttachment[]
}

export type SessionStatus = "idle" | "running" | "waiting" | "failed"

export interface SessionsApi {
  create(input: CreateSessionInput): Promise<SessionRef>
  status(ref: SessionRef): SessionStatus
  open(ref: SessionRef): void
}

export interface ProjectSummary {
  id: string
  name: string
}

export interface ProjectsApi {
  list(): readonly ProjectSummary[]
  currentId(): string | undefined
}

export interface ServerApi {
  fetch(path: string, init?: RequestInit): Promise<Response>
  operation<Result = unknown>(name: string, input?: unknown): Promise<Result>
}

export type PluginPlatform = "desktop" | "web"

export interface PluginContext {
  pluginId: string
  pluginVersion: string
  platform: PluginPlatform
  locale: string
  currentProjectId(): string | undefined
  currentSession(): SessionRef | undefined
  signal: AbortSignal
}

export type ToastKind = "info" | "success" | "warning" | "error"

export interface Toast {
  kind: ToastKind
  title: string
  description?: string
}

export interface Confirmation {
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
}

export interface UiApi {
  toast(toast: Toast): void
  confirm(confirmation: Confirmation): Promise<boolean>
}

export interface I18nApi {
  t(key: string, params?: Readonly<Record<string, string | number>>): string
}
