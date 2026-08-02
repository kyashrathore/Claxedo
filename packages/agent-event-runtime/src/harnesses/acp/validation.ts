import type { ToolCallContent } from "./types"
import { diagnoseTranslation, shape, type AcpDiagnostics } from "./diagnostics"

function rawRecord(value: unknown) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

type ValidationContext = { diagnostics: AcpDiagnostics; toolCallId?: string; title?: string; kind?: string }

function details(ctx: ValidationContext) {
  return {
    toolCallId: ctx.toolCallId,
    title: ctx.title,
    kind: ctx.kind,
  }
}

export function safeMeta(value: unknown, ctx: ValidationContext) {
  if (value === undefined || value === null) return
  const row = rawRecord(value)
  if (row) return row
  diagnoseTranslation(ctx.diagnostics, "acp.malformed_raw_input", {
    ...details(ctx),
    reason: "invalid_meta",
    shape: shape(value),
  })
}

export function safeRawInput(value: unknown, ctx: ValidationContext) {
  if (value === undefined || value === null) return value
  const row = rawRecord(value)
  if (row) return row
  diagnoseTranslation(ctx.diagnostics, "acp.malformed_raw_input", {
    ...details(ctx),
    reason: "rawInput_not_object",
    shape: shape(value),
  })
  return { raw: value }
}

export function safeRawOutput(value: unknown, ctx: ValidationContext) {
  if (value === undefined || value === null) return value
  if (typeof value === "symbol" || typeof value === "function") {
    diagnoseTranslation(ctx.diagnostics, "acp.malformed_raw_output", {
      ...details(ctx),
      reason: "rawOutput_unserializable",
      shape: shape(value),
    })
    return String(value)
  }
  return value
}

export function safeLocations(value: unknown, ctx: ValidationContext) {
  if (value === undefined || value === null) return value as undefined | null
  if (!Array.isArray(value)) {
    diagnoseTranslation(ctx.diagnostics, "acp.malformed_location", {
      ...details(ctx),
      reason: "locations_not_array",
      shape: shape(value),
    })
    return null
  }
  const out = value.flatMap((item) => {
    const row = rawRecord(item)
    if (typeof row?.path === "string" && (row.line === undefined || row.line === null || typeof row.line === "number")) {
      return [{ path: row.path, ...(row.line !== undefined ? { line: row.line as number | null } : {}) }]
    }
    diagnoseTranslation(ctx.diagnostics, "acp.malformed_location", {
      ...details(ctx),
      reason: "location_invalid",
      shape: shape(item),
    })
    return []
  })
  return out
}

export function safeContent(value: unknown, ctx: ValidationContext) {
  if (value === undefined || value === null) return value as undefined | null
  if (!Array.isArray(value)) {
    diagnoseTranslation(ctx.diagnostics, "acp.dropped_content", {
      ...details(ctx),
      reason: "content_not_array",
      shape: shape(value),
    })
    return null
  }
  return value.flatMap((item) => {
    const row = rawRecord(item)
    if (typeof row?.type === "string") return [row as ToolCallContent]
    diagnoseTranslation(ctx.diagnostics, "acp.dropped_content", {
      ...details(ctx),
      reason: "content_item_invalid",
      shape: shape(item),
    })
    return []
  })
}
