import { isRecord, object } from "../value"
import type { ContentBlock, SessionUpdate, ToolCallContent } from "./types"
import { diagnoseTranslation, shape, type AcpDiagnostics } from "./diagnostics"

type ValidationContext = { diagnostics: AcpDiagnostics; toolCallId?: string; title?: string; kind?: string }

function details(ctx: ValidationContext) {
  return {
    toolCallId: ctx.toolCallId,
    title: ctx.title,
    kind: ctx.kind,
  }
}

export function safeMeta(value: unknown, ctx: ValidationContext): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined
  const row = object(value)
  if (row) return row
  diagnoseTranslation(ctx.diagnostics, "acp.malformed_raw_input", {
    ...details(ctx),
    reason: "invalid_meta",
    shape: shape(value),
  })
  return undefined
}

export function safeRawInput(value: unknown, ctx: ValidationContext) {
  if (value === undefined || value === null) return value
  const row = object(value)
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
  if (value === undefined || value === null) return value
  if (!Array.isArray(value)) {
    diagnoseTranslation(ctx.diagnostics, "acp.malformed_location", {
      ...details(ctx),
      reason: "locations_not_array",
      shape: shape(value),
    })
    return null
  }
  const out = value.flatMap((item) => {
    const row = object(item)
    if (typeof row?.path === "string" && (row.line === undefined || row.line === null || typeof row.line === "number")) {
      return [{ path: row.path, ...(row.line !== undefined ? { line: row.line } : {}) }]
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
  if (value === undefined || value === null) return value
  if (!Array.isArray(value)) {
    diagnoseTranslation(ctx.diagnostics, "acp.dropped_content", {
      ...details(ctx),
      reason: "content_not_array",
      shape: shape(value),
    })
    return null
  }
  return value.flatMap((item) => {
    if (isToolCallContent(item)) return [item]
    diagnoseTranslation(ctx.diagnostics, "acp.dropped_content", {
      ...details(ctx),
      reason: "content_item_invalid",
      shape: shape(item),
    })
    return []
  })
}

// ---------------------------------------------------------------------------
// Wire-shape guards. The only place ACP payloads earn their SDK types.
// ---------------------------------------------------------------------------

/** Exhaustive over ContentBlock: a new SDK variant must be listed or this stops compiling. */
const CONTENT_BLOCK_TYPES = {
  text: true,
  image: true,
  audio: true,
  resource_link: true,
  resource: true,
} satisfies Record<ContentBlock["type"], true>

export function isContentBlock(value: unknown): value is ContentBlock {
  const row = object(value)
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

export function isToolCallContent(value: unknown): value is ToolCallContent {
  const row = object(value)
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

/** Splits "not a content block at all" from "known type, bad fields" from "type this SDK does not model". */
export function checkContentBlock(value: unknown): ContentBlockCheck {
  const row = object(value)
  if (!row || typeof row.type !== "string") return { ok: false, reason: "content_missing_type" }
  if (!Object.hasOwn(CONTENT_BLOCK_TYPES, row.type)) return { ok: false, reason: "unknown_content_block" }
  if (!isContentBlock(value)) return { ok: false, reason: "content_missing_required_fields" }
  return { ok: true, block: value }
}

/**
 * Exhaustive over SessionUpdate: a new SDK variant must be listed or this stops compiling.
 * The value records the required fields `translateSessionUpdate` reads without re-validating;
 * every other field of every variant is validated inside the translator itself.
 */
type RequiredField = readonly [field: string, kind: "string" | "number"]

const SESSION_UPDATE_REQUIRED_FIELDS = new Map<string, readonly RequiredField[]>(Object.entries({
  agent_message_chunk: [],
  agent_thought_chunk: [],
  user_message_chunk: [],
  tool_call: [["toolCallId", "string"]],
  tool_call_update: [["toolCallId", "string"]],
  plan: [],
  plan_update: [],
  plan_removed: [],
  available_commands_update: [],
  current_mode_update: [["currentModeId", "string"]],
  config_option_update: [],
  session_info_update: [],
  usage_update: [["size", "number"], ["used", "number"]],
} satisfies Record<SessionUpdate["sessionUpdate"], readonly RequiredField[]>))

/** Boundary parse for `session/update` notification payloads arriving as `unknown`. */
export function isSessionUpdate(value: unknown): value is SessionUpdate {
  const row = object(value)
  if (!row || typeof row.sessionUpdate !== "string") return false
  const required = SESSION_UPDATE_REQUIRED_FIELDS.get(row.sessionUpdate)
  if (!required) return false
  return required.every(([field, kind]) => typeof row[field] === kind)
}
