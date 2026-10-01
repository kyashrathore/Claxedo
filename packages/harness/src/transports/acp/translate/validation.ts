import { isRecord, asRecord } from "@claxedo/agent-runtime-contract"
import type { ContentBlock, ToolCallContent } from "./types"
import { own } from "../../../translate/value"
import { diagnoseTranslation, shape, type AcpDiagnostics, type AcpTranslationDiagnostic } from "./diagnostics"

type ValidationContext = { diagnostics: AcpDiagnostics; toolCallId?: string; title?: string; kind?: string }

function malformed(ctx: ValidationContext, event: AcpTranslationDiagnostic, reason: string, value: unknown): void {
  diagnoseTranslation(ctx.diagnostics, event, {
    toolCallId: ctx.toolCallId,
    title: ctx.title,
    kind: ctx.kind,
    reason,
    shape: shape(value),
  })
}

export function safeMeta(value: unknown, ctx: ValidationContext): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined
  const row = asRecord(value)
  if (row) return row
  malformed(ctx, "acp.malformed_raw_input", "invalid_meta", value)
  return undefined
}

export function safeRawInput(value: unknown, ctx: ValidationContext) {
  if (value === undefined || value === null) return value
  const row = asRecord(value)
  if (row) return row
  malformed(ctx, "acp.malformed_raw_input", "rawInput_not_object", value)
  return { raw: value }
}

export function safeRawOutput(value: unknown, ctx: ValidationContext) {
  if (value === undefined || value === null) return value
  if (typeof value === "symbol" || typeof value === "function") {
    malformed(ctx, "acp.malformed_raw_output", "rawOutput_unserializable", value)
    return String(value)
  }
  return value
}

function safeItems<T>(value: unknown, ctx: ValidationContext, event: AcpTranslationDiagnostic,
  arrayReason: string, itemReason: string, decode: (item: unknown) => T | undefined) {
  if (value === undefined || value === null) return value
  if (!Array.isArray(value)) {
    malformed(ctx, event, arrayReason, value)
    return null
  }
  return value.flatMap((item) => {
    const decoded = decode(item)
    if (decoded !== undefined) return [decoded]
    malformed(ctx, event, itemReason, item)
    return []
  })
}

export function safeLocations(value: unknown, ctx: ValidationContext) {
  return safeItems(value, ctx, "acp.malformed_location", "locations_not_array", "location_invalid", (item) => {
    const row = asRecord(item)
    if (typeof row?.path === "string" && (row.line === undefined || row.line === null || typeof row.line === "number")) {
      return { path: row.path, ...(row.line !== undefined ? { line: row.line } : {}) }
    }
    return undefined
  })
}

export function safeContent(value: unknown, ctx: ValidationContext) {
  return safeItems(value, ctx, "acp.dropped_content", "content_not_array", "content_item_invalid",
    (item) => isToolCallContent(item) ? item : undefined)
}


const contentFields: Record<ContentBlock["type"], readonly string[]> = {
  text: ["text"], image: ["mimeType", "data"], audio: ["mimeType", "data"],
  resource_link: ["uri", "name"], resource: ["resource"],
}

export function isContentBlock(value: unknown): value is ContentBlock {
  const row = asRecord(value)
  const fields = typeof row?.type === "string" ? own(contentFields, row.type) : undefined
  return !!fields && fields.every((field) => row!.type === "resource" ? isRecord(row![field]) : typeof row![field] === "string")
}

export function isToolCallContent(value: unknown): value is ToolCallContent {
  const row = asRecord(value)
  if (!row) return false
  switch (row.type) {
    case "content":
      return isContentBlock(row.content)
    case "diff":
      return typeof row.path === "string" && typeof row.newText === "string"
    case "terminal":
      return typeof row.terminalId === "string"
    default:
      return false
  }
}

export type ContentBlockCheck =
  | { ok: true; block: ContentBlock }
  | { ok: false; reason: "content_missing_type" | "content_missing_required_fields" | "unknown_content_block" }

export function checkContentBlock(value: unknown): ContentBlockCheck {
  const row = asRecord(value)
  if (!row || typeof row.type !== "string") return { ok: false, reason: "content_missing_type" }
  if (!own(contentFields, row.type)) return { ok: false, reason: "unknown_content_block" }
  if (!isContentBlock(value)) return { ok: false, reason: "content_missing_required_fields" }
  return { ok: true, block: value }
}
