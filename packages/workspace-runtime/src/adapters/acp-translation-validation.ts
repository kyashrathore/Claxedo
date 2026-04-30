import { z } from "zod"
import type { ToolCallContent } from "@agentclientprotocol/sdk"
import { diagnoseTranslation, shape } from "./acp-translation-diagnostics"

const Location = z.object({
  path: z.string(),
  line: z.number().nullable().optional(),
}).passthrough()

const Content = z.object({
  type: z.string(),
}).passthrough()

const Meta = z.record(z.unknown()).nullable().optional()

function rawRecord(value: unknown) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

export function safeMeta(value: unknown, ctx: { toolCallId?: string; title?: string; kind?: string }) {
  const parsed = Meta.safeParse(value)
  if (parsed.success) return parsed.data ?? undefined
  diagnoseTranslation("acp.malformed_raw_input", {
    ...ctx,
    reason: "invalid_meta",
    shape: shape(value),
  })
}

export function safeRawInput(value: unknown, ctx: { toolCallId?: string; title?: string; kind?: string }) {
  if (value === undefined || value === null) return value
  const row = rawRecord(value)
  if (row) return row
  diagnoseTranslation("acp.malformed_raw_input", {
    ...ctx,
    reason: "rawInput_not_object",
    shape: shape(value),
  })
  return { raw: value }
}

export function safeRawOutput(value: unknown, ctx: { toolCallId?: string; title?: string; kind?: string }) {
  if (value === undefined || value === null) return value
  if (typeof value === "symbol" || typeof value === "function") {
    diagnoseTranslation("acp.malformed_raw_output", {
      ...ctx,
      reason: "rawOutput_unserializable",
      shape: shape(value),
    })
    return String(value)
  }
  return value
}

export function safeLocations(value: unknown, ctx: { toolCallId?: string; title?: string; kind?: string }) {
  if (value === undefined || value === null) return value as undefined | null
  if (!Array.isArray(value)) {
    diagnoseTranslation("acp.malformed_location", {
      ...ctx,
      reason: "locations_not_array",
      shape: shape(value),
    })
    return null
  }
  const out = value.flatMap((item) => {
    const parsed = Location.safeParse(item)
    if (parsed.success) return [parsed.data]
    diagnoseTranslation("acp.malformed_location", {
      ...ctx,
      reason: "location_invalid",
      shape: shape(item),
    })
    return []
  })
  return out
}

export function safeContent(value: unknown, ctx: { toolCallId?: string; title?: string; kind?: string }) {
  if (value === undefined || value === null) return value as undefined | null
  if (!Array.isArray(value)) {
    diagnoseTranslation("acp.dropped_content", {
      ...ctx,
      reason: "content_not_array",
      shape: shape(value),
    })
    return null
  }
  return value.flatMap((item) => {
    const parsed = Content.safeParse(item)
    if (parsed.success) return [parsed.data as ToolCallContent]
    diagnoseTranslation("acp.dropped_content", {
      ...ctx,
      reason: "content_item_invalid",
      shape: shape(item),
    })
    return []
  })
}
