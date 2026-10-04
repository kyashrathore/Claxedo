import { isRecord } from "@claxedo/helpers/guards"
import type {
  CommandContext,
  Confirmation,
  CreateSessionInput,
  MentionInsert,
  MentionItem,
  PluginPlatform,
  ProjectSummary,
  SessionRef,
  SessionStatus,
  ThemeDefinition,
  Toast,
  WorkbenchTab,
} from "@claxedo/plugin-api"

export const FRAME_BOOT = "claxedo:plugin-frame-boot"

export const FRAME_RUNTIME_GLOBAL = "__claxedoPluginFrame"

export type FrameMirror = {
  readonly locale: string
  readonly projects: readonly ProjectSummary[]
  readonly currentProjectId: string | undefined
  readonly currentSession: SessionRef | undefined
  readonly tabs: readonly WorkbenchTab[]
  readonly statuses: Readonly<Record<string, SessionStatus>>
}

export type FrameContext = {
  readonly pluginId: string
  readonly pluginVersion: string
  readonly platform: PluginPlatform
}

export type RenderTarget =
  | { readonly kind: "page"; readonly id: string; readonly path: string; readonly params: Readonly<Record<string, string>> }
  | { readonly kind: "settings"; readonly id: string }
  | { readonly kind: "overlay"; readonly id: string }

export type FrameBoot = {
  readonly type: typeof FRAME_BOOT
  readonly runtime: string
  readonly code: string
  readonly css: string
  readonly theme: { readonly id: string | undefined; readonly colorScheme: string | undefined }
  readonly context: FrameContext
  readonly mirror: FrameMirror
  readonly target?: RenderTarget
}

export type Registration =
  | { readonly kind: "sidebar"; readonly id: string; readonly label: string; readonly pageId: string; readonly icon?: string; readonly order?: number }
  | { readonly kind: "page"; readonly id: string; readonly path: string; readonly title: string }
  | { readonly kind: "settings"; readonly id: string; readonly title: string; readonly icon?: string; readonly order?: number }
  | { readonly kind: "overlay"; readonly id: string; readonly keybinding: string }
  | { readonly kind: "command"; readonly id: string; readonly title: string; readonly keybinding?: string; readonly category?: string }
  | { readonly kind: "mention"; readonly id: string; readonly label: string }
  | { readonly kind: "theme"; readonly theme: ThemeDefinition }

export type FoundMention = { readonly item: MentionItem; readonly insert: MentionInsert }

export type HostCall =
  | { readonly method: "pages.open"; readonly pageId: string; readonly params?: Readonly<Record<string, string>> }
  | { readonly method: "overlays.open" | "overlays.close"; readonly overlayId: string }
  | { readonly method: "commands.run"; readonly commandId: string }
  | { readonly method: "workbench.activate" | "workbench.close"; readonly tabId: string }
  | { readonly method: "workbench.move"; readonly tabId: string; readonly index: number }
  | { readonly method: "sessions.create"; readonly input: CreateSessionInput }
  | { readonly method: "sessions.open"; readonly ref: SessionRef }
  | { readonly method: "server.fetch"; readonly path: string; readonly init: FrameRequestInit }
  | { readonly method: "server.operation"; readonly name: string; readonly input: unknown }
  | { readonly method: "ui.toast"; readonly toast: Toast }
  | { readonly method: "ui.confirm"; readonly confirmation: Confirmation }

export type FrameRequestInit = {
  readonly method?: string
  readonly headers?: readonly (readonly [string, string])[]
  readonly body?: string
}

export type FrameResponse = {
  readonly status: number
  readonly statusText: string
  readonly headers: readonly (readonly [string, string])[]
  readonly body: string
}

export type FrameInvoke =
  | { readonly method: "command.run"; readonly commandId: string; readonly context: CommandContext }
  | { readonly method: "mention.search"; readonly mentionId: string; readonly query: string; readonly context: CommandContext }

export type HostToFrame =
  | { readonly type: "mirror"; readonly mirror: FrameMirror }
  | { readonly type: "invoke"; readonly id: number; readonly invoke: FrameInvoke }
  | { readonly type: "result"; readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly type: "result"; readonly id: number; readonly ok: false; readonly reason: string }

export type FrameToHost =
  | { readonly type: "register"; readonly key: number; readonly registration: Registration }
  | { readonly type: "unregister"; readonly key: number }
  | { readonly type: "call"; readonly id: number; readonly call: HostCall }
  | { readonly type: "result"; readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly type: "result"; readonly id: number; readonly ok: false; readonly reason: string }
  | { readonly type: "activated" }
  | { readonly type: "failed"; readonly reason: string }

export class FrameProtocolError extends Error {
  constructor(what: string) {
    super(`The plugin frame sent ${what} that does not match its protocol`)
    this.name = "FrameProtocolError"
  }
}

function mentionItemFromFrame(value: unknown): MentionItem | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.label !== "string") return undefined
  return {
    id: value.id,
    label: value.label,
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(typeof value.icon === "string" ? { icon: value.icon } : {}),
  }
}

function mentionInsertFromFrame(value: unknown): MentionInsert | undefined {
  if (!isRecord(value) || typeof value.text !== "string") return undefined
  if (value.attachment === undefined) return { text: value.text }
  const { attachment } = value
  if (!isRecord(attachment) || typeof attachment.kind !== "string" || typeof attachment.reference !== "string") return undefined
  return { text: value.text, attachment: { kind: attachment.kind, reference: attachment.reference } }
}

function foundMentionFromFrame(value: unknown): FoundMention {
  const item = isRecord(value) ? mentionItemFromFrame(value.item) : undefined
  const insert = isRecord(value) ? mentionInsertFromFrame(value.insert) : undefined
  if (!item || !insert) throw new FrameProtocolError("a mention")
  return { item, insert }
}

export function foundMentionsFromFrame(value: unknown): FoundMention[] {
  if (!Array.isArray(value)) throw new FrameProtocolError("mention results")
  return value.map(foundMentionFromFrame)
}

function isHeaderPair(value: unknown): value is readonly [string, string] {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "string"
}

export function frameResponseFromHost(value: unknown): FrameResponse {
  if (!isRecord(value) || typeof value.status !== "number" || typeof value.statusText !== "string" || typeof value.body !== "string") throw new FrameProtocolError("a response")
  const { headers } = value
  if (!Array.isArray(headers) || !headers.every(isHeaderPair)) throw new FrameProtocolError("response headers")
  return { status: value.status, statusText: value.statusText, headers, body: value.body }
}

export function sessionRefFromHost(value: unknown): SessionRef {
  if (!isRecord(value) || typeof value.sessionId !== "string" || typeof value.workspaceId !== "string") throw new FrameProtocolError("a session")
  return { sessionId: value.sessionId, workspaceId: value.workspaceId }
}
