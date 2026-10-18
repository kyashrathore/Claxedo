import type { McpAppTool } from "@/server"
import type { ConfirmOptions } from "@/ui"

export type AppReader = { readonly owner: boolean; readonly send: boolean }

export type ConsentKey =
  | "mcpApps.consent.cancel"
  | "mcpApps.consent.toolCall.title"
  | "mcpApps.consent.toolCall.body"
  | "mcpApps.consent.toolCall.confirm"
  | "mcpApps.consent.message.title"
  | "mcpApps.consent.message.body"
  | "mcpApps.consent.message.confirm"

export type ConsentText = (key: ConsentKey, params?: Record<string, string>) => string

export type ToolCallDecision =
  | { readonly kind: "refuse"; readonly reason: string }
  | { readonly kind: "ask" }
  | { readonly kind: "run" }

const ARGUMENTS_PREVIEW_CHARS = 600

export function toolCallDecision(reader: AppReader, name: string, tool: McpAppTool | undefined): ToolCallDecision {
  if (!reader.owner) return { kind: "refuse", reason: "Only the session's owner can run tools from an app" }
  if (!tool) return { kind: "refuse", reason: `The server has no tool named ${name}` }
  if (!tool.visibleToApp) return { kind: "refuse", reason: `The tool ${name} is not offered to apps` }
  return tool.readOnly ? { kind: "run" } : { kind: "ask" }
}

function argumentsPreview(args: Readonly<Record<string, unknown>>): string {
  const text = JSON.stringify(args)
  return text.length > ARGUMENTS_PREVIEW_CHARS ? `${text.slice(0, ARGUMENTS_PREVIEW_CHARS)}…` : text
}

export function toolCallConfirm(text: ConsentText, server: string, tool: string, args: Readonly<Record<string, unknown>>): ConfirmOptions {
  return {
    title: text("mcpApps.consent.toolCall.title"),
    body: text("mcpApps.consent.toolCall.body", { server, tool, arguments: argumentsPreview(args) }),
    confirmLabel: text("mcpApps.consent.toolCall.confirm"),
    cancelLabel: text("mcpApps.consent.cancel"),
  }
}

export function messageConfirm(text: ConsentText, message: string): ConfirmOptions {
  return {
    title: text("mcpApps.consent.message.title"),
    body: text("mcpApps.consent.message.body", { message }),
    confirmLabel: text("mcpApps.consent.message.confirm"),
    cancelLabel: text("mcpApps.consent.cancel"),
  }
}
