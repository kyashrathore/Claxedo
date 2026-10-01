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

function safeItems<T>(
  value: unknown,
  ctx: ValidationContext,
  event: AcpTranslationDiagnostic,
  arrayReason: string,
  itemReason: string,
  decode: (item: unknown) => T | undefined,
) {
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
  return safeItems(value, ctx, "acp.dropped_content", "content_not_array", "content_item_invalid", (item) =>
    isToolCallContent(item) ? item : undefined,
  )
}

const CONTENT_BLOCK_TYPES = {
  text: true,
  image: true,
  audio: true,
  resource_link: true,
  resource: true,
} satisfies Record<ContentBlock["type"], true>

function isContentBlock(value: unknown): value is ContentBlock {
  const row = asRecord(value)
  if (!row) return false
  switch (row.type) {
    case "text":
      return typeof row.text === "string"
    case "image":
    case "audio":
      return typeof row.mimeType === "string" && typeof row.data === "string"
    case "resource_link":
      return typeof row.uri === "string" && typeof row.name === "string"
    case "resource":
      return isRecord(row.resource)
    default:
      return false
  }
}

function isToolCallContent(value: unknown): value is ToolCallContent {
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

type ContentBlockCheck =
  | { ok: true; block: ContentBlock }
  | { ok: false; reason: "content_missing_type" | "content_missing_required_fields" | "unknown_content_block" }

export function checkContentBlock(value: unknown): ContentBlockCheck {
  const row = asRecord(value)
  if (!row || typeof row.type !== "string") return { ok: false, reason: "content_missing_type" }
  if (!own(CONTENT_BLOCK_TYPES, row.type)) return { ok: false, reason: "unknown_content_block" }
  if (!isContentBlock(value)) return { ok: false, reason: "content_missing_required_fields" }
  return { ok: true, block: value }
}
