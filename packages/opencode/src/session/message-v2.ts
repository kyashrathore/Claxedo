import { SessionID, MessageID } from "./schema"
import {
  LATEST_SURFACE_MAX_INFO_BYTES,
  LATEST_SURFACE_MAX_OPTIONAL_INFO_VALUE_BYTES,
  LATEST_SURFACE_MAX_PART_BYTES,
  LATEST_SURFACE_MAX_TEXT_PART_BYTES,
  projectLatestSurfaceInfo,
  selectLatestSurfaceTextCandidates,
  type LatestSurfaceTextBudget,
} from "@opencode-ai/schema/session-message-surface"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ProviderV2 } from "@opencode-ai/core/provider"
import {
  APIError,
  AbortedError,
  Assistant,
  AuthError,
  CompactionPart,
  ContextOverflowError,
  Info,
  OutputLengthError,
  Part,
  SubtaskPart,
  User,
  WithParts,
} from "@opencode-ai/core/v1/session"

import { NamedError } from "@opencode-ai/core/util/error"
import { APICallError, convertToModelMessages, LoadAPIKeyError, type ModelMessage, type UIMessage } from "ai"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { NotFoundError } from "@/storage/storage"
import { and } from "drizzle-orm"
import { asc } from "drizzle-orm"
import { desc } from "drizzle-orm"
import { eq } from "drizzle-orm"
import { gt } from "drizzle-orm"
import { gte } from "drizzle-orm"
import { inArray } from "drizzle-orm"
import { lt } from "drizzle-orm"
import { or } from "drizzle-orm"
import { sql } from "drizzle-orm"
import { MessageTable, PartTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { projectSessionV2Messages } from "./message-v1-compat"
import { ProviderError } from "@/provider/error"
import { iife } from "@/util/iife"
import { errorMessage } from "@/util/error"
import { isMedia } from "@/util/media"
import type { SystemError } from "bun"
import type { Provider } from "@/provider/provider"
import { Effect, Schema } from "effect"

/** Error shape thrown by Bun's fetch() when gzip/br decompression fails mid-stream */
interface FetchDecompressionError extends Error {
  code: "ZlibError"
  errno: number
  path: string
}

export const SYNTHETIC_ATTACHMENT_PROMPT = "Attached media from tool result:"
export { isMedia }

function truncateToolOutput(text: string, maxChars?: number) {
  if (!maxChars || text.length <= maxChars) return text
  const omitted = text.length - maxChars
  return `${text.slice(0, maxChars)}\n[Tool output truncated for compaction: omitted ${omitted} chars]`
}

export const Event = {
  Updated: SessionV1.Event.MessageUpdated,
  Removed: SessionV1.Event.MessageRemoved,
  PartUpdated: SessionV1.Event.PartUpdated,
  PartDelta: SessionV1.Event.PartDelta,
  PartRemoved: SessionV1.Event.PartRemoved,
}

const Cursor = Schema.Struct({
  id: MessageID,
  time: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  source: Schema.optional(Schema.Literals(["legacy", "session-v2"])),
  seq: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
})
type Cursor = typeof Cursor.Type

const decodeCursor = Schema.decodeUnknownSync(Cursor)

export const cursor = {
  encode(input: Cursor) {
    return Buffer.from(JSON.stringify(input)).toString("base64url")
  },
  decode(input: string) {
    const value = decodeCursor(JSON.parse(Buffer.from(input, "base64url").toString("utf8")))
    if (value.source === "session-v2" && value.seq === undefined) {
      throw new Error("Session V2 message cursor is missing its sequence")
    }
    return value
  },
}

const info = (row: typeof MessageTable.$inferSelect) =>
  ({
    ...row.data,
    id: row.id,
    sessionID: row.session_id,
  }) as Info

const part = (row: typeof PartTable.$inferSelect) =>
  ({
    ...row.data,
    id: row.id,
    sessionID: row.session_id,
    messageID: row.message_id,
  }) as Part

const older = (row: Cursor) =>
  or(lt(MessageTable.time_created, row.time), and(eq(MessageTable.time_created, row.time), lt(MessageTable.id, row.id)))

const newerOrEqual = (row: Cursor) =>
  or(
    gt(MessageTable.time_created, row.time),
    and(eq(MessageTable.time_created, row.time), gte(MessageTable.id, row.id)),
  )

function hydrate(db: Database.Interface["db"], rows: (typeof MessageTable.$inferSelect)[]) {
  const ids = rows.map((row) => row.id)
  const partByMessage = new Map<string, Part[]>()
  return Effect.gen(function* () {
    if (ids.length > 0) {
      const partRows = yield* db
        .select()
        .from(PartTable)
        .where(inArray(PartTable.message_id, ids))
        .orderBy(PartTable.message_id, PartTable.ordinal)
        .all()
        .pipe(Effect.orDie)
      for (const row of partRows) {
        const next = part(row)
        const list = partByMessage.get(row.message_id)
        if (list) list.push(next)
        else partByMessage.set(row.message_id, [next])
      }
    }

    return rows.map((row) => ({
      info: info(row),
      parts: partByMessage.get(row.id) ?? [],
    }))
  })
}

function providerMeta(metadata: Record<string, any> | undefined) {
  if (!metadata) return undefined
  const { providerExecuted: _, ...rest } = metadata
  return Object.keys(rest).length > 0 ? rest : undefined
}

export const toModelMessagesEffect = Effect.fnUntraced(function* (
  input: WithParts[],
  model: Provider.Model,
  options?: { stripMedia?: boolean; toolOutputMaxChars?: number },
) {
  const result: UIMessage[] = []
  const toolNames = new Set<string>()
  // Track media from tool results that need to be injected as user messages
  // for providers that don't support that media type in tool results.
  //
  // OpenAI-compatible APIs only support string content in tool results, so we need
  // to extract media and inject as user messages. Some SDKs only support a subset
  // of media in tool results; e.g. Bedrock supports images but not PDFs there.
  //
  // Only apply this workaround if the model actually supports that media input -
  // otherwise unsupportedParts() will turn it into a user-visible error.
  const supportsMediaInToolResult = (attachment: { mime: string }) => {
    if (model.api.npm === "@ai-sdk/anthropic") return true
    if (model.api.npm === "@ai-sdk/openai") return true
    if (model.api.npm === "@ai-sdk/amazon-bedrock/mantle") return true
    if (model.api.npm === "@ai-sdk/amazon-bedrock") return attachment.mime.startsWith("image/")
    if (model.api.npm === "@ai-sdk/xai") return attachment.mime.startsWith("image/")
    if (model.api.npm === "@ai-sdk/google-vertex/anthropic") return true
    if (model.api.npm === "@ai-sdk/google") {
      const id = model.api.id.toLowerCase()
      return id.includes("gemini-3") && !id.includes("gemini-2")
    }
    return false
  }

  const toModelOutput = (options: { toolCallId: string; input: unknown; output: unknown }) => {
    const output = options.output
    if (typeof output === "string") {
      return { type: "text", value: output }
    }

    if (typeof output === "object") {
      const outputObject = output as {
        text: string
        attachments?: Array<{ mime: string; url: string }>
      }
      const attachments = (outputObject.attachments ?? []).filter((attachment) => {
        return attachment.url.startsWith("data:") && attachment.url.includes(",")
      })

      return {
        type: "content",
        value: [
          ...(outputObject.text ? [{ type: "text", text: outputObject.text }] : []),
          ...attachments.map((attachment) => ({
            type: "media",
            mediaType: attachment.mime,
            data: iife(() => {
              const commaIndex = attachment.url.indexOf(",")
              return commaIndex === -1 ? attachment.url : attachment.url.slice(commaIndex + 1)
            }),
          })),
        ],
      }
    }

    return { type: "json", value: output as never }
  }

  for (const msg of input) {
    if (msg.parts.length === 0) continue

    if (msg.info.role === "user") {
      const userMessage: UIMessage = {
        id: msg.info.id,
        role: "user",
        parts: [],
      }
      for (const part of msg.parts) {
        // User message parts should never be empty
        if (part.type === "text" && !part.ignored && part.text !== "")
          userMessage.parts.push({
            type: "text",
            text: part.text,
          })
        // text/plain and directory files are converted into text parts, ignore them
        if (part.type === "file" && part.mime !== "text/plain" && part.mime !== "application/x-directory") {
          if (options?.stripMedia && isMedia(part.mime)) {
            userMessage.parts.push({
              type: "text",
              text: `[Attached ${part.mime}: ${part.filename ?? "file"}]`,
            })
          } else {
            userMessage.parts.push({
              type: "file",
              url: part.url,
              mediaType: part.mime,
              filename: part.filename,
            })
          }
        }

        if (part.type === "compaction") {
          userMessage.parts.push({
            type: "text",
            text: "What did we do so far?",
          })
        }
        if (part.type === "subtask") {
          userMessage.parts.push({
            type: "text",
            text: "The following tool was executed by the user",
          })
        }
      }
      if (userMessage.parts.length > 0) result.push(userMessage)
    }

    if (msg.info.role === "assistant") {
      const differentModel = `${model.providerID}/${model.id}` !== `${msg.info.providerID}/${msg.info.modelID}`
      const media: Array<{ mime: string; url: string; filename?: string }> = []

      if (
        msg.info.error &&
        !(
          AbortedError.isInstance(msg.info.error) &&
          msg.parts.some((part) => part.type !== "step-start" && part.type !== "reasoning")
        )
      ) {
        continue
      }
      const assistantMessage: UIMessage = {
        id: msg.info.id,
        role: "assistant",
        parts: [],
      }
      // Anthropic adaptive thinking can persist assistant turns like:
      // step-start, reasoning(signature), text(""), step-start,
      // reasoning(signature). The empty text part is a structural separator,
      // but it does not carry the signature metadata itself. Dropping it shifts
      // signed thinking positions after step-start splitting/provider regrouping;
      // keeping it as "" is filtered by the AI SDK and rejected by Anthropic.
      // It is unclear whether this shape originates in our stream processing,
      // a proxy, or a lower-level library, but preserving a non-empty separator
      // here is the only safe replay point we have.
      // Use a single space so the separator survives replay without changing
      // the neighboring signed reasoning blocks.
      const hasSignedReasoning = msg.parts.some((part) => {
        if (part.type !== "reasoning") return false
        return part.metadata?.anthropic?.signature != null
      })
      for (const part of msg.parts) {
        if (part.type === "text") {
          const text = part.text === "" && hasSignedReasoning ? " " : part.text
          assistantMessage.parts.push({
            type: "text",
            text,
            ...(differentModel ? {} : { providerMetadata: part.metadata }),
          })
        }
        if (part.type === "step-start")
          assistantMessage.parts.push({
            type: "step-start",
          })
        if (part.type === "tool") {
          toolNames.add(part.tool)
          if (part.state.status === "completed") {
            const outputText = part.state.time.compacted
              ? "[Old tool result content cleared]"
              : truncateToolOutput(part.state.output, options?.toolOutputMaxChars)
            const attachments = part.state.time.compacted || options?.stripMedia ? [] : (part.state.attachments ?? [])

            // For providers that don't support media in tool results, extract media files
            // (images, PDFs) to be sent as a separate user message
            const mediaAttachments = attachments.filter((a) => isMedia(a.mime))
            const extractedMedia = mediaAttachments.filter((a) => !supportsMediaInToolResult(a))
            if (extractedMedia.length > 0) {
              media.push(...extractedMedia)
            }
            const finalAttachments = attachments.filter((a) => !isMedia(a.mime) || supportsMediaInToolResult(a))

            const output =
              finalAttachments.length > 0
                ? {
                    text: outputText,
                    attachments: finalAttachments,
                  }
                : outputText

            assistantMessage.parts.push({
              type: ("tool-" + part.tool) as `tool-${string}`,
              state: "output-available",
              toolCallId: part.callID,
              input: part.state.input,
              output,
              ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
              ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
            })
          }
          if (part.state.status === "error") {
            const output = part.state.metadata?.interrupted === true ? part.state.metadata.output : undefined
            if (typeof output === "string") {
              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-available",
                toolCallId: part.callID,
                input: part.state.input,
                output,
                ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
                ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
              })
            } else {
              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-error",
                toolCallId: part.callID,
                input: part.state.input,
                errorText: part.state.error,
                ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
                ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
              })
            }
          }
          // Handle pending/running tool calls to prevent dangling tool_use blocks
          // Anthropic/Claude APIs require every tool_use to have a corresponding tool_result
          if (part.state.status === "pending" || part.state.status === "running")
            assistantMessage.parts.push({
              type: ("tool-" + part.tool) as `tool-${string}`,
              state: "output-error",
              toolCallId: part.callID,
              input: part.state.input,
              errorText: "[Tool execution was interrupted]",
              ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
              ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
            })
        }
        if (part.type === "reasoning") {
          if (differentModel) {
            if (part.text.trim().length > 0)
              assistantMessage.parts.push({
                type: "text",
                text: part.text,
              })
            continue
          }
          assistantMessage.parts.push({
            type: "reasoning",
            text: part.text,
            providerMetadata: part.metadata,
          })
        }
      }
      if (assistantMessage.parts.length > 0) {
        result.push(assistantMessage)
        // Inject pending media as a user message for providers that don't support
        // media (images, PDFs) in tool results
        if (media.length > 0) {
          result.push({
            id: MessageID.ascending(),
            role: "user",
            parts: [
              {
                type: "text" as const,
                text: SYNTHETIC_ATTACHMENT_PROMPT,
              },
              ...media.map((attachment) => ({
                type: "file" as const,
                url: attachment.url,
                mediaType: attachment.mime,
                filename: attachment.filename,
              })),
            ],
          })
        }
      }
    }
  }

  const tools = Object.fromEntries(Array.from(toolNames).map((toolName) => [toolName, { toModelOutput }]))

  return yield* Effect.promise(() =>
    convertToModelMessages(
      result.filter((msg) => msg.parts.some((part) => part.type !== "step-start")),
      {
        //@ts-expect-error (convertToModelMessages expects a ToolSet but only actually needs tools[name]?.toModelOutput)
        tools,
      },
    ),
  )
})

export function toModelMessages(
  input: WithParts[],
  model: Provider.Model,
  options?: { stripMedia?: boolean; toolOutputMaxChars?: number },
): Promise<ModelMessage[]> {
  return Effect.runPromise(toModelMessagesEffect(input, model, options))
}

export const page = Effect.fn("MessageV2.page")(function* (input: {
  sessionID: SessionID
  limit: number
  before?: string
}) {
  const { db } = yield* Database.Service
  const before = input.before ? cursor.decode(input.before) : undefined
  const where = before
    ? and(eq(MessageTable.session_id, input.sessionID), older(before))
    : eq(MessageTable.session_id, input.sessionID)
  const rows = yield* db
    .select()
    .from(MessageTable)
    .where(where)
    .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
    .limit(input.limit + 1)
    .all()
    .pipe(Effect.orDie)
  if (rows.length === 0) {
    const row = yield* db
      .select({ id: SessionTable.id })
      .from(SessionTable)
      .where(eq(SessionTable.id, input.sessionID))
      .get()
      .pipe(Effect.orDie)
    if (!row) return yield* new NotFoundError({ message: `Session not found: ${input.sessionID}` })
    return {
      items: [] as WithParts[],
      more: false,
    }
  }

  const more = rows.length > input.limit
  const slice = more ? rows.slice(0, input.limit) : rows
  const items = yield* hydrate(db, slice)
  items.reverse()
  const tail = slice.at(-1)
  return {
    items,
    more,
    cursor: more && tail ? cursor.encode({ id: tail.id, time: tail.time_created }) : undefined,
  }
})

type CompatibilitySession = Parameters<typeof projectSessionV2Messages>[0]
type LegacyRow = typeof MessageTable.$inferSelect
type SessionV2Row = typeof SessionMessageTable.$inferSelect
type LegacySurfaceRow = Omit<LegacyRow, "data"> & { data: string | null }
type SessionV2SurfaceRow = Omit<SessionV2Row, "data"> & { data: string | null }
type CompatibilityPosition = Cursor & {
  source: "legacy" | "session-v2"
}
type CompatibilityItem = {
  item: WithParts
  position: CompatibilityPosition
}

const decodeSessionV2Message = Schema.decodeUnknownEffect(SessionMessage.Message)
const visibleSessionV2Message = or(eq(SessionMessageTable.type, "user"), eq(SessionMessageTable.type, "assistant"))

const legacySurfaceData = sql<string>`
  CASE
    WHEN json_extract(${MessageTable.data}, '$.role') = 'user'
    THEN json_remove(${MessageTable.data}, '$.summary', '$.system', '$.tools')
    WHEN json_extract(${MessageTable.data}, '$.role') = 'assistant'
      AND length(CAST(json_extract(${MessageTable.data}, '$.error') AS BLOB)) > ${LATEST_SURFACE_MAX_OPTIONAL_INFO_VALUE_BYTES}
    THEN json_remove(${MessageTable.data}, '$.error')
    ELSE ${MessageTable.data}
  END
`

const legacySurfaceSelection = {
  id: MessageTable.id,
  session_id: MessageTable.session_id,
  time_created: MessageTable.time_created,
  time_updated: MessageTable.time_updated,
  data: sql<string | null>`
    CASE
      WHEN length(CAST(${legacySurfaceData} AS BLOB)) <= ${LATEST_SURFACE_MAX_INFO_BYTES}
      THEN ${legacySurfaceData}
      ELSE NULL
    END
  `.as("data"),
}

const sessionV2SurfaceData = sql<string>`
  CASE
    WHEN ${SessionMessageTable.type} = 'user'
    THEN json_set(
      json_remove(${SessionMessageTable.data}, '$.files', '$.agents', '$.metadata'),
      '$.text',
      ''
    )
    WHEN ${SessionMessageTable.type} = 'assistant'
    THEN json_set(
      CASE
        WHEN length(CAST(json_extract(${SessionMessageTable.data}, '$.error') AS BLOB)) > ${LATEST_SURFACE_MAX_OPTIONAL_INFO_VALUE_BYTES}
        THEN json_remove(${SessionMessageTable.data}, '$.error')
        ELSE ${SessionMessageTable.data}
      END,
      '$.content',
      json('[]')
    )
    ELSE ${SessionMessageTable.data}
  END
`

const sessionV2SurfaceSelection = {
  id: SessionMessageTable.id,
  session_id: SessionMessageTable.session_id,
  type: SessionMessageTable.type,
  seq: SessionMessageTable.seq,
  time_created: SessionMessageTable.time_created,
  time_updated: SessionMessageTable.time_updated,
  data: sql<string | null>`
    CASE
      WHEN length(CAST(${sessionV2SurfaceData} AS BLOB)) <= ${LATEST_SURFACE_MAX_INFO_BYTES}
      THEN ${sessionV2SurfaceData}
      ELSE NULL
    END
  `.as("data"),
}

type SurfaceBudget = LatestSurfaceTextBudget

function surfaceBudget(): SurfaceBudget {
  return { textBytes: 0, partBytes: 0, count: 0 }
}

function selectSurfaceCandidateIndexes(
  candidates: ReadonlyArray<{ textBytes: number; partBytes: number }>,
  budget: SurfaceBudget,
) {
  const selected = selectLatestSurfaceTextCandidates(candidates, budget)
  Object.assign(budget, selected.budget)
  return selected.indexes
}

function compatibilityPosition(value: Cursor): CompatibilityPosition {
  if (value.source === "session-v2") {
    if (value.seq === undefined) throw new Error("Session V2 message cursor is missing its sequence")
    return { ...value, source: "session-v2", seq: value.seq }
  }
  return { ...value, source: "legacy" }
}

function compareCompatibilityPosition(a: CompatibilityPosition, b: CompatibilityPosition) {
  if (a.source !== b.source) return a.source === "legacy" ? -1 : 1
  if (a.source === "session-v2" && b.source === "session-v2") return a.seq! - b.seq!
  return a.time - b.time || a.id.localeCompare(b.id)
}

function mergeCompatibilityItems(legacy: CompatibilityItem[], sessionV2: CompatibilityItem[]) {
  const byID = new Map<string, CompatibilityItem>()
  for (const item of legacy) byID.set(item.item.info.id, item)
  // Session V2 is the canonical representation when a migration/replay has
  // deliberately projected the same message identity into both stores.
  for (const item of sessionV2) byID.set(item.item.info.id, item)
  return [...byID.values()].sort((a, b) => compareCompatibilityPosition(a.position, b.position))
}

function enforceLatestSurfaceInfo(items: CompatibilityItem[]) {
  const projected = items.map((entry) => projectLatestSurfaceInfo(entry.item.info as unknown as Record<string, unknown>))
  if (projected.some((value) => value === undefined)) return [] as CompatibilityItem[]
  return items.map((entry, index) => ({
    ...entry,
    item: { ...entry.item, info: projected[index]! as WithParts["info"] },
  }))
}

function assertLegacyTurnOwnership(
  db: Database.Interface["db"],
  sessionID: SessionID,
  boundary: Pick<CompatibilityPosition, "id" | "time">,
) {
  return Effect.gen(function* () {
    const invalid = yield* db
      .select({ id: MessageTable.id })
      .from(MessageTable)
      .where(
        and(
          eq(MessageTable.session_id, sessionID),
          newerOrEqual(boundary),
          sql`${MessageTable.id} <> ${boundary.id}`,
          sql`(
            json_extract(${MessageTable.data}, '$.role') IS NOT 'assistant'
            OR json_extract(${MessageTable.data}, '$.parentID') IS NOT ${boundary.id}
          )`,
        ),
      )
      .limit(1)
      .get()
      .pipe(Effect.orDie)
    if (invalid) return yield* Effect.fail(new Error(`Latest turn projection is not contiguous for session: ${sessionID}`))
  })
}

function hydrateLegacyCompatibilityRows(db: Database.Interface["db"], rows: LegacyRow[]) {
  return hydrate(db, rows).pipe(
    Effect.map((items) =>
      items.map((item, index): CompatibilityItem => ({
        item,
        position: {
          source: "legacy",
          id: rows[index]!.id,
          time: rows[index]!.time_created,
        },
      })),
    ),
  )
}

/**
 * Hydrate the first-paint legacy projection without decoding omitted JSON.
 * Message envelopes are already projected by SQLite and only text part rows
 * cross the persistence boundary.
 */
function hydrateLegacySurfaceCompatibilityRows(
  db: Database.Interface["db"],
  rows: LegacySurfaceRow[],
  budget: SurfaceBudget = surfaceBudget(),
) {
  const ids = rows.map((row) => row.id)
  return Effect.gen(function* () {
    if (rows.some((row) => row.data === null)) return [] as CompatibilityItem[]
    const partByMessage = new Map<string, Part[]>()
    if (ids.length > 0) {
      const projectedPart = sql<string>`json_set(
        ${PartTable.data},
        '$.id', ${PartTable.id},
        '$.sessionID', ${PartTable.session_id},
        '$.messageID', ${PartTable.message_id}
      )`
      const finalMessageID = ids.at(-1)!
      const candidates = yield* db
        .select({
          id: PartTable.id,
          message_id: PartTable.message_id,
          ordinal: PartTable.ordinal,
          textBytes: sql<number>`length(CAST(json_extract(${PartTable.data}, '$.text') AS BLOB))`.as("text_bytes"),
          partBytes: sql<number>`length(CAST(${projectedPart} AS BLOB))`.as("part_bytes"),
        })
        .from(PartTable)
        .where(
          and(
            inArray(PartTable.message_id, ids),
            sql`json_extract(${PartTable.data}, '$.type') = 'text'`,
            sql`typeof(json_extract(${PartTable.data}, '$.text')) = 'text'`,
            sql`length(CAST(json_extract(${PartTable.data}, '$.text') AS BLOB)) <= ${LATEST_SURFACE_MAX_TEXT_PART_BYTES}`,
            sql`length(CAST(${projectedPart} AS BLOB)) <= ${LATEST_SURFACE_MAX_PART_BYTES}`,
          ),
        )
        .orderBy(sql`CASE WHEN ${PartTable.message_id} = ${finalMessageID} THEN 0 ELSE 1 END`, desc(PartTable.ordinal))
        .all()
        .pipe(Effect.orDie)
      const selected = selectSurfaceCandidateIndexes(candidates, budget).map((index) => candidates[index]!.id)
      const partRows = selected.length === 0
        ? []
        : yield* db
            .select()
            .from(PartTable)
            .where(inArray(PartTable.id, selected))
            .orderBy(PartTable.message_id, PartTable.ordinal)
            .all()
            .pipe(Effect.orDie)
      for (const row of partRows) {
        const next = part(row)
        const list = partByMessage.get(row.message_id)
        if (list) list.push(next)
        else partByMessage.set(row.message_id, [next])
      }
    }
    return rows.map((row): CompatibilityItem => {
      const decoded = { ...row, data: JSON.parse(row.data!) } as LegacyRow
      return {
        item: {
          info: info(decoded),
          parts: partByMessage.get(row.id) ?? [],
        },
        position: {
          source: "legacy",
          id: row.id,
          time: row.time_created,
        },
      }
    })
  })
}

function sessionV2InitialParentID(db: Database.Interface["db"], sessionID: SessionID, rows: SessionV2Row[]) {
  const first = rows.toSorted((a, b) => a.seq - b.seq)[0]
  if (!first || first.type === "user") return Effect.succeed(undefined)
  return Effect.gen(function* () {
    const sessionV2User = yield* db
      .select({ id: SessionMessageTable.id })
      .from(SessionMessageTable)
      .where(
        and(
          eq(SessionMessageTable.session_id, sessionID),
          eq(SessionMessageTable.type, "user"),
          lt(SessionMessageTable.seq, first.seq),
        ),
      )
      .orderBy(desc(SessionMessageTable.seq))
      .limit(1)
      .get()
      .pipe(Effect.orDie)
    if (sessionV2User) return MessageID.ascending(sessionV2User.id)

    // Session V2 is the later persistence epoch. Its first row may be an
    // assistant continuing the final legacy user turn, so ownership crosses
    // the storage boundary even though pagination/order do not interleave it.
    const legacyUser = yield* db
      .select({ id: MessageTable.id })
      .from(MessageTable)
      .where(and(eq(MessageTable.session_id, sessionID), sql`json_extract(${MessageTable.data}, '$.role') = 'user'`))
      .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
      .limit(1)
      .get()
      .pipe(Effect.orDie)
    return legacyUser ? MessageID.ascending(legacyUser.id) : undefined
  })
}

function hydrateSessionV2CompatibilityRows(
  db: Database.Interface["db"],
  sessionID: SessionID,
  session: CompatibilitySession,
  rows: SessionV2Row[],
) {
  const ordered = rows.toSorted((a, b) => a.seq - b.seq)
  return Effect.gen(function* () {
    const initialParentID = yield* sessionV2InitialParentID(db, sessionID, ordered)
    const decoded = yield* Effect.forEach(ordered, (row) =>
      decodeSessionV2Message({ ...row.data, id: row.id, type: row.type }).pipe(
        Effect.map((message) => ({ row, message })),
      ),
    )
    const rowByID = new Map<string, SessionV2Row>(decoded.map(({ row }) => [row.id, row]))
    return projectSessionV2Messages(
      session,
      decoded.map(({ message }) => message),
      initialParentID,
    ).map((item): CompatibilityItem => {
      const row = rowByID.get(item.info.id)!
      return {
        item,
        position: {
          source: "session-v2",
          id: MessageID.ascending(row.id),
          time: row.time_created,
          seq: row.seq,
        },
      }
    })
  })
}

function hydrateSessionV2SurfaceCompatibilityRows(
  db: Database.Interface["db"],
  sessionID: SessionID,
  session: CompatibilitySession,
  rows: SessionV2SurfaceRow[],
  budget: SurfaceBudget = surfaceBudget(),
) {
  return Effect.gen(function* () {
    if (rows.some((row) => row.data === null)) return [] as CompatibilityItem[]
    const ids = rows.map((row) => row.id)
    if (ids.length === 0) return [] as CompatibilityItem[]
    const idList = sql.join(ids.map((id) => sql`${id}`), sql`, `)
    const candidates = yield* db.all<{
      messageID: string
      seq: number
      contentIndex: number
      textBytes: number
      partBytes: number
    }>(sql`
      SELECT message_id AS messageID, seq, content_index AS contentIndex, text_bytes AS textBytes, part_bytes AS partBytes
      FROM (
        SELECT
          ${SessionMessageTable.id} AS message_id,
          ${SessionMessageTable.seq} AS seq,
          -1 AS content_index,
          length(CAST(json_extract(${SessionMessageTable.data}, '$.text') AS BLOB)) AS text_bytes,
          length(CAST(json_object(
            'id', 'prt_v2_' || CASE
              WHEN ${SessionMessageTable.id} LIKE 'msg_%' THEN substr(${SessionMessageTable.id}, 5)
              WHEN ${SessionMessageTable.id} LIKE 'msg%' THEN substr(${SessionMessageTable.id}, 4)
              ELSE ${SessionMessageTable.id}
            END || '_0',
            'sessionID', ${sessionID},
            'messageID', ${SessionMessageTable.id},
            'type', 'text',
            'text', json_extract(${SessionMessageTable.data}, '$.text')
          ) AS BLOB)) AS part_bytes
        FROM ${SessionMessageTable}
        WHERE ${SessionMessageTable.id} IN (${idList})
          AND ${SessionMessageTable.type} = 'user'
          AND typeof(json_extract(${SessionMessageTable.data}, '$.text')) = 'text'
          AND json_extract(${SessionMessageTable.data}, '$.text') <> ''
        UNION ALL
        SELECT
          ${SessionMessageTable.id} AS message_id,
          ${SessionMessageTable.seq} AS seq,
          CAST(content.key AS INTEGER) AS content_index,
          length(CAST(json_extract(content.value, '$.text') AS BLOB)) AS text_bytes,
          length(CAST(json_object(
            'id', 'prt_v2_' || CASE
              WHEN ${SessionMessageTable.id} LIKE 'msg_%' THEN substr(${SessionMessageTable.id}, 5)
              WHEN ${SessionMessageTable.id} LIKE 'msg%' THEN substr(${SessionMessageTable.id}, 4)
              ELSE ${SessionMessageTable.id}
            END || '_' || CAST(content.key AS INTEGER),
            'sessionID', ${sessionID},
            'messageID', ${SessionMessageTable.id},
            'type', 'text',
            'text', json_extract(content.value, '$.text')
          ) AS BLOB)) AS part_bytes
        FROM ${SessionMessageTable}, json_each(${SessionMessageTable.data}, '$.content') AS content
        WHERE ${SessionMessageTable.id} IN (${idList})
          AND ${SessionMessageTable.type} = 'assistant'
          AND json_extract(content.value, '$.type') = 'text'
          AND typeof(json_extract(content.value, '$.text')) = 'text'
      ) AS surface_candidates
      WHERE text_bytes <= ${LATEST_SURFACE_MAX_TEXT_PART_BYTES}
        AND part_bytes <= ${LATEST_SURFACE_MAX_PART_BYTES}
      ORDER BY seq DESC, content_index DESC
    `).pipe(Effect.orDie)
    const selectedCandidates = selectSurfaceCandidateIndexes(candidates, budget).map((index) => candidates[index]!)
    const values = selectedCandidates.length === 0
      ? []
      : yield* db.all<{ messageID: string; contentIndex: number; value: string }>(sql`
          SELECT
            ${SessionMessageTable.id} AS messageID,
            selected.content_index AS contentIndex,
            CASE
              WHEN selected.content_index = -1 THEN json_quote(json_extract(${SessionMessageTable.data}, '$.text'))
              ELSE json_extract(${SessionMessageTable.data}, '$.content[' || selected.content_index || ']')
            END AS value
          FROM ${SessionMessageTable}
          INNER JOIN (
            ${sql.join(
              selectedCandidates.map((candidate) => sql`SELECT ${candidate.messageID} AS message_id, ${candidate.contentIndex} AS content_index`),
              sql` UNION ALL `,
            )}
          ) AS selected ON selected.message_id = ${SessionMessageTable.id}
          ORDER BY ${SessionMessageTable.seq} ASC, selected.content_index ASC
        `).pipe(Effect.orDie)
    const valuesByMessage = new Map<string, Array<{ contentIndex: number; value: unknown }>>()
    for (const value of values) {
      const list = valuesByMessage.get(value.messageID) ?? []
      list.push({ contentIndex: value.contentIndex, value: JSON.parse(value.value) })
      valuesByMessage.set(value.messageID, list)
    }
    const hydrated = rows.map((row) => {
      const data = JSON.parse(row.data!) as Record<string, unknown>
      const selected = valuesByMessage.get(row.id) ?? []
      if (row.type === "user") data.text = selected[0]?.value ?? ""
      if (row.type === "assistant") data.content = selected.map((value) => value.value)
      return { ...row, data } as SessionV2Row
    })
    return yield* hydrateSessionV2CompatibilityRows(db, sessionID, session, hydrated)
  })
}

/**
 * The OpenCode compatibility API has two persisted message epochs:
 * legacy MessageV2 rows first, then Session V2 rows produced after its
 * adoption. Every list shape uses this one read model. The opaque cursor records
 * both the epoch and its native position, so pagination cannot change stores
 * based on whether one query happened to be empty.
 */
export const compatibilityReadModel = {
  all: Effect.fn("MessageV2.compatibilityReadModel.all")(function* (input: {
    sessionID: SessionID
    session: CompatibilitySession
  }) {
    const { db } = yield* Database.Service
    const legacyRows = yield* db
      .select()
      .from(MessageTable)
      .where(eq(MessageTable.session_id, input.sessionID))
      .orderBy(asc(MessageTable.time_created), asc(MessageTable.id))
      .all()
      .pipe(Effect.orDie)
    const sessionV2Rows = yield* db
      .select()
      .from(SessionMessageTable)
      .where(and(eq(SessionMessageTable.session_id, input.sessionID), visibleSessionV2Message))
      .orderBy(asc(SessionMessageTable.seq))
      .all()
      .pipe(Effect.orDie)
    const legacy = yield* hydrateLegacyCompatibilityRows(db, legacyRows)
    const sessionV2 = yield* hydrateSessionV2CompatibilityRows(db, input.sessionID, input.session, sessionV2Rows)
    return mergeCompatibilityItems(legacy, sessionV2).map(({ item }) => item)
  }),

  page: Effect.fn("MessageV2.compatibilityReadModel.page")(function* (input: {
    sessionID: SessionID
    session: CompatibilitySession
    limit: number
    before?: string
  }) {
    const { db } = yield* Database.Service
    const before = input.before ? compatibilityPosition(cursor.decode(input.before)) : undefined
    const legacyWhere =
      before?.source === "legacy"
        ? and(eq(MessageTable.session_id, input.sessionID), older(before))
        : eq(MessageTable.session_id, input.sessionID)
    const legacyRows = yield* db
      .select()
      .from(MessageTable)
      .where(legacyWhere)
      .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
      .limit(input.limit + 1)
      .all()
      .pipe(Effect.orDie)
    const sessionV2Rows =
      before?.source === "legacy"
        ? []
        : yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(
                eq(SessionMessageTable.session_id, input.sessionID),
                visibleSessionV2Message,
                before?.source === "session-v2" ? lt(SessionMessageTable.seq, before.seq!) : undefined,
              ),
            )
            .orderBy(desc(SessionMessageTable.seq))
            .limit(input.limit + 1)
            .all()
            .pipe(Effect.orDie)
    const legacy = yield* hydrateLegacyCompatibilityRows(db, legacyRows)
    const sessionV2 = yield* hydrateSessionV2CompatibilityRows(db, input.sessionID, input.session, sessionV2Rows)
    const merged = mergeCompatibilityItems(legacy, sessionV2)
    const more = merged.length > input.limit
    const selected = more ? merged.slice(-input.limit) : merged
    const boundary = selected[0]?.position
    return {
      items: selected.map(({ item }) => item),
      more,
      cursor: more && boundary ? cursor.encode(boundary) : undefined,
    }
  }),

  latestSurface: Effect.fn("MessageV2.compatibilityReadModel.latestSurface")(function* (input: {
    sessionID: SessionID
    session: CompatibilitySession
  }) {
    const { db } = yield* Database.Service
    const sessionV2Boundary = yield* db
      .select(sessionV2SurfaceSelection)
      .from(SessionMessageTable)
      .where(and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.type, "user")))
      .orderBy(desc(SessionMessageTable.seq))
      .limit(1)
      .get()
      .pipe(Effect.orDie)

    if (sessionV2Boundary) {
      const final = yield* db
        .select(sessionV2SurfaceSelection)
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.session_id, input.sessionID),
            visibleSessionV2Message,
            gte(SessionMessageTable.seq, sessionV2Boundary.seq),
          ),
        )
        .orderBy(desc(SessionMessageTable.seq))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      const selectedRows = final && final.id !== sessionV2Boundary.id ? [sessionV2Boundary, final] : [sessionV2Boundary]
      const selected = enforceLatestSurfaceInfo(
        yield* hydrateSessionV2SurfaceCompatibilityRows(db, input.sessionID, input.session, selectedRows),
      )
      const boundaryRow = selectedRows.at(-1)!
      const boundary: CompatibilityPosition = {
        source: "session-v2",
        id: MessageID.ascending(boundaryRow.id),
        time: boundaryRow.time_created,
        seq: boundaryRow.seq,
      }
      const olderSessionV2 = yield* db
        .select({ id: SessionMessageTable.id })
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.session_id, input.sessionID),
            visibleSessionV2Message,
            lt(SessionMessageTable.seq, sessionV2Boundary.seq),
          ),
        )
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      const omittedSessionV2 =
        final && final.seq > sessionV2Boundary.seq
          ? yield* db
              .select({ id: SessionMessageTable.id })
              .from(SessionMessageTable)
              .where(
                and(
                  eq(SessionMessageTable.session_id, input.sessionID),
                  visibleSessionV2Message,
                  gt(SessionMessageTable.seq, sessionV2Boundary.seq),
                  lt(SessionMessageTable.seq, final.seq),
                ),
              )
              .limit(1)
              .get()
              .pipe(Effect.orDie)
          : undefined
      const legacyExists = yield* db
        .select({ id: MessageTable.id })
        .from(MessageTable)
        .where(eq(MessageTable.session_id, input.sessionID))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      const more = Boolean(olderSessionV2 || omittedSessionV2 || legacyExists)
      return {
        items: selected.map(({ item }) => item),
        more,
        cursor: more ? cursor.encode(boundary) : undefined,
      }
    }

    const legacyBoundary = yield* db
      .select(legacySurfaceSelection)
      .from(MessageTable)
      .where(
        and(eq(MessageTable.session_id, input.sessionID), sql`json_extract(${MessageTable.data}, '$.role') = 'user'`),
      )
      .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
      .limit(1)
      .get()
      .pipe(Effect.orDie)
    if (!legacyBoundary) return { items: [] as WithParts[], more: false, cursor: undefined }
    yield* assertLegacyTurnOwnership(db, input.sessionID, {
      id: legacyBoundary.id,
      time: legacyBoundary.time_created,
    })

    const sessionV2Final = yield* db
      .select(sessionV2SurfaceSelection)
      .from(SessionMessageTable)
      .where(and(eq(SessionMessageTable.session_id, input.sessionID), visibleSessionV2Message))
      .orderBy(desc(SessionMessageTable.seq))
      .limit(1)
      .get()
      .pipe(Effect.orDie)
    if (sessionV2Final) {
      const budget = surfaceBudget()
      const sessionV2 = yield* hydrateSessionV2SurfaceCompatibilityRows(
        db,
        input.sessionID,
        input.session,
        [sessionV2Final],
        budget,
      )
      const legacy = yield* hydrateLegacySurfaceCompatibilityRows(db, [legacyBoundary], budget)
      const selected = enforceLatestSurfaceInfo(mergeCompatibilityItems(legacy, sessionV2))
      const otherLegacy = yield* db
        .select({ id: MessageTable.id })
        .from(MessageTable)
        .where(and(eq(MessageTable.session_id, input.sessionID), sql`${MessageTable.id} <> ${legacyBoundary.id}`))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      const earlierSessionV2 = yield* db
        .select({ id: SessionMessageTable.id })
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.session_id, input.sessionID),
            visibleSessionV2Message,
            lt(SessionMessageTable.seq, sessionV2Final.seq),
          ),
        )
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      const more = Boolean(otherLegacy || earlierSessionV2)
      return {
        items: selected.map(({ item }) => item),
        more,
        cursor: more
          ? cursor.encode({
              source: "session-v2",
              id: MessageID.ascending(sessionV2Final.id),
              time: sessionV2Final.time_created,
              seq: sessionV2Final.seq,
            })
          : undefined,
      }
    }

    const legacyPosition = { id: legacyBoundary.id, time: legacyBoundary.time_created }
    const legacyFinal = yield* db
      .select(legacySurfaceSelection)
      .from(MessageTable)
      .where(and(eq(MessageTable.session_id, input.sessionID), newerOrEqual(legacyPosition)))
      .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
      .limit(1)
      .get()
      .pipe(Effect.orDie)
    const selectedRows =
      legacyFinal && legacyFinal.id !== legacyBoundary.id ? [legacyBoundary, legacyFinal] : [legacyBoundary]
    const selected = enforceLatestSurfaceInfo(yield* hydrateLegacySurfaceCompatibilityRows(db, selectedRows))
    const boundaryRow = selectedRows.at(-1)!
    const boundary: CompatibilityPosition = {
      source: "legacy",
      id: boundaryRow.id,
      time: boundaryRow.time_created,
    }
    const olderLegacy = yield* db
      .select({ id: MessageTable.id })
      .from(MessageTable)
      .where(and(eq(MessageTable.session_id, input.sessionID), older(legacyPosition)))
      .limit(1)
      .get()
      .pipe(Effect.orDie)
    const omittedLegacy =
      legacyFinal && legacyFinal.id !== legacyBoundary.id
        ? yield* db
            .select({ id: MessageTable.id })
            .from(MessageTable)
            .where(
              and(
                eq(MessageTable.session_id, input.sessionID),
                newerOrEqual(legacyPosition),
                older({ id: legacyFinal.id, time: legacyFinal.time_created }),
                sql`${MessageTable.id} <> ${legacyBoundary.id}`,
              ),
            )
            .limit(1)
            .get()
            .pipe(Effect.orDie)
        : undefined
    const more = Boolean(olderLegacy || omittedLegacy)
    return {
      items: selected.map(({ item }) => item),
      more,
      cursor: more ? cursor.encode(boundary) : undefined,
    }
  }),

  latestTurn: Effect.fn("MessageV2.compatibilityReadModel.latestTurn")(function* (input: {
    sessionID: SessionID
    session: CompatibilitySession
  }) {
    const { db } = yield* Database.Service
    const sessionV2Boundary = yield* db
      .select()
      .from(SessionMessageTable)
      .where(and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.type, "user")))
      .orderBy(desc(SessionMessageTable.seq))
      .limit(1)
      .get()
      .pipe(Effect.orDie)

    if (sessionV2Boundary) {
      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.session_id, input.sessionID),
            visibleSessionV2Message,
            gte(SessionMessageTable.seq, sessionV2Boundary.seq),
          ),
        )
        .orderBy(asc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie)
      const olderSessionV2 = yield* db
        .select({ id: SessionMessageTable.id })
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.session_id, input.sessionID),
            visibleSessionV2Message,
            lt(SessionMessageTable.seq, sessionV2Boundary.seq),
          ),
        )
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      const legacyExists = yield* db
        .select({ id: MessageTable.id })
        .from(MessageTable)
        .where(eq(MessageTable.session_id, input.sessionID))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      const items = yield* hydrateSessionV2CompatibilityRows(db, input.sessionID, input.session, rows)
      const position: CompatibilityPosition = {
        source: "session-v2",
        id: MessageID.ascending(sessionV2Boundary.id),
        time: sessionV2Boundary.time_created,
        seq: sessionV2Boundary.seq,
      }
      const more = Boolean(olderSessionV2 || legacyExists)
      return {
        items: items.map(({ item }) => item),
        more,
        cursor: more ? cursor.encode(position) : undefined,
      }
    }

    const legacyBoundary = yield* db
      .select({ id: MessageTable.id, time: MessageTable.time_created })
      .from(MessageTable)
      .where(
        and(eq(MessageTable.session_id, input.sessionID), sql`json_extract(${MessageTable.data}, '$.role') = 'user'`),
      )
      .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
      .limit(1)
      .get()
      .pipe(Effect.orDie)
    if (!legacyBoundary) return { items: [] as WithParts[], more: false, cursor: undefined }
    yield* assertLegacyTurnOwnership(db, input.sessionID, legacyBoundary)

    const legacyRows = yield* db
      .select()
      .from(MessageTable)
      .where(and(eq(MessageTable.session_id, input.sessionID), newerOrEqual(legacyBoundary)))
      .orderBy(asc(MessageTable.time_created), asc(MessageTable.id))
      .all()
      .pipe(Effect.orDie)
    const sessionV2Rows = yield* db
      .select()
      .from(SessionMessageTable)
      .where(and(eq(SessionMessageTable.session_id, input.sessionID), visibleSessionV2Message))
      .orderBy(asc(SessionMessageTable.seq))
      .all()
      .pipe(Effect.orDie)
    const olderLegacy = yield* db
      .select({ id: MessageTable.id })
      .from(MessageTable)
      .where(and(eq(MessageTable.session_id, input.sessionID), older(legacyBoundary)))
      .limit(1)
      .get()
      .pipe(Effect.orDie)
    const legacy = yield* hydrateLegacyCompatibilityRows(db, legacyRows)
    const sessionV2 = yield* hydrateSessionV2CompatibilityRows(db, input.sessionID, input.session, sessionV2Rows)
    const more = Boolean(olderLegacy)
    return {
      items: mergeCompatibilityItems(legacy, sessionV2).map(({ item }) => item),
      more,
      cursor: more ? cursor.encode({ ...legacyBoundary, source: "legacy" }) : undefined,
    }
  }),
}

export function stream(sessionID: SessionID) {
  const size = 50
  return Effect.gen(function* () {
    const result = [] as WithParts[]
    let before: string | undefined
    while (true) {
      const next = yield* page({ sessionID, limit: size, before }).pipe(
        Effect.catchIf(NotFoundError.isInstance, () =>
          Effect.succeed({ items: [] as WithParts[], more: false, cursor: undefined }),
        ),
      )
      if (next.items.length === 0) break
      for (let i = next.items.length - 1; i >= 0; i--) {
        const item = next.items[i]
        if (item) result.push(item)
      }
      if (!next.more || !next.cursor) break
      before = next.cursor
    }
    return result
  })
}

export function parts(messageID: MessageID) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const rows = yield* db
      .select()
      .from(PartTable)
      .where(eq(PartTable.message_id, messageID))
      .orderBy(PartTable.ordinal)
      .all()
      .pipe(Effect.orDie)
    return rows.map(part)
  })
}

export const get = Effect.fn("MessageV2.get")(function* (input: { sessionID: SessionID; messageID: MessageID }) {
  const { db } = yield* Database.Service
  const row = yield* db
    .select()
    .from(MessageTable)
    .where(and(eq(MessageTable.id, input.messageID), eq(MessageTable.session_id, input.sessionID)))
    .get()
    .pipe(Effect.orDie)
  if (!row) return yield* new NotFoundError({ message: `Message not found: ${input.messageID}` })
  return {
    info: info(row),
    parts: yield* parts(input.messageID),
  }
})

export function filterCompacted(msgs: Iterable<WithParts>) {
  const result = [] as WithParts[]
  const completed = new Set<string>()
  let retain: MessageID | undefined
  for (const msg of msgs) {
    result.push(msg)
    if (retain) {
      if (msg.info.id === retain) break
      continue
    }
    if (msg.info.role === "user" && completed.has(msg.info.id)) {
      const part = msg.parts.find((item): item is CompactionPart => item.type === "compaction")
      if (!part) continue
      if (!part.tail_start_id) break
      retain = part.tail_start_id
      if (msg.info.id === retain) break
      continue
    }
    if (msg.info.role === "user" && completed.has(msg.info.id) && msg.parts.some((part) => part.type === "compaction"))
      break
    if (msg.info.role === "assistant" && msg.info.summary && msg.info.finish && !msg.info.error)
      completed.add(msg.info.parentID)
  }
  result.reverse()
  const compactionIndex = result.findLastIndex(
    (msg) =>
      msg.info.role === "user" &&
      msg.parts.some((item): item is CompactionPart => item.type === "compaction" && item.tail_start_id !== undefined),
  )
  const compaction = result[compactionIndex]
  const part = compaction?.parts.find(
    (item): item is CompactionPart => item.type === "compaction" && item.tail_start_id !== undefined,
  )
  const summaryIndex = compaction
    ? result.findIndex(
        (msg, index) =>
          index > compactionIndex &&
          msg.info.role === "assistant" &&
          msg.info.summary &&
          msg.info.parentID === compaction.info.id,
      )
    : -1
  const tailIndex = part?.tail_start_id ? result.findIndex((msg) => msg.info.id === part.tail_start_id) : -1
  if (tailIndex >= 0 && tailIndex < compactionIndex && summaryIndex > compactionIndex) {
    return [
      ...result.slice(compactionIndex, summaryIndex + 1),
      ...result.slice(tailIndex, compactionIndex),
      ...result.slice(summaryIndex + 1),
    ]
  }
  return result
}

export const filterCompactedEffect = Effect.fnUntraced(function* (sessionID: SessionID) {
  return filterCompacted(yield* stream(sessionID))
})

// filterCompacted reorders messages for model consumption
// ([compaction-user, summary, ...retained tail..., continue-user]), so array
// position is not chronological. Derive each binding by max id (MessageID
// is monotonic via MessageID.ascending) so a pre-compaction overflowing tail
// assistant doesn't get mistaken for the most recent turn. tasks are
// compaction/subtask parts attached to user messages newer than the latest
// finished assistant — i.e. unprocessed work.
export function latest(msgs: WithParts[]) {
  let user: User | undefined
  let assistant: Assistant | undefined
  let finished: Assistant | undefined
  for (const msg of msgs) {
    const info = msg.info
    if (info.role === "user" && (!user || info.id > user.id)) user = info
    if (info.role === "assistant" && (!assistant || info.id > assistant.id)) assistant = info
    if (info.role === "assistant" && info.finish && (!finished || info.id > finished.id)) finished = info
  }
  const tasks = msgs.flatMap((m) =>
    finished && m.info.id <= finished.id
      ? []
      : m.parts.filter((p): p is CompactionPart | SubtaskPart => p.type === "compaction" || p.type === "subtask"),
  )
  return { user, assistant, finished, tasks }
}

export function fromError(
  e: unknown,
  ctx: { providerID: ProviderV2.ID; aborted?: boolean },
): NonNullable<Assistant["error"]> {
  switch (true) {
    case e instanceof DOMException && e.name === "AbortError":
      return new AbortedError(
        { message: e.message },
        {
          cause: e,
        },
      ).toObject()
    case OutputLengthError.isInstance(e):
      return e
    case LoadAPIKeyError.isInstance(e):
      return new AuthError(
        {
          providerID: ctx.providerID,
          message: e.message,
        },
        { cause: e },
      ).toObject()
    case (e as SystemError)?.code === "ECONNRESET":
      return new APIError(
        {
          message: "Connection reset by server",
          isRetryable: true,
          metadata: {
            code: (e as SystemError).code ?? "",
            syscall: (e as SystemError).syscall ?? "",
            message: (e as SystemError).message ?? "",
          },
        },
        { cause: e },
      ).toObject()
    case e instanceof Error && (e as FetchDecompressionError).code === "ZlibError":
      if (ctx.aborted) {
        return new AbortedError({ message: e.message }, { cause: e }).toObject()
      }
      return new APIError(
        {
          message: "Response decompression failed",
          isRetryable: true,
          metadata: {
            code: (e as FetchDecompressionError).code,
            message: e.message,
          },
        },
        { cause: e },
      ).toObject()
    case e instanceof ProviderError.HeaderTimeoutError:
      return new APIError(
        {
          message: e.message,
          isRetryable: true,
          metadata: {
            code: e.name,
            timeoutMs: String(e.ms),
          },
        },
        { cause: e },
      ).toObject()
    case e instanceof ProviderError.ResponseStreamError:
      return new APIError(
        {
          message: e.message,
          isRetryable: true,
          metadata: {
            code: e.name,
          },
        },
        { cause: e },
      ).toObject()
    case APICallError.isInstance(e):
      const parsed = ProviderError.parseAPICallError({
        providerID: ctx.providerID,
        error: e,
      })
      if (parsed.type === "context_overflow") {
        return new ContextOverflowError(
          {
            message: parsed.message,
            responseBody: parsed.responseBody,
          },
          { cause: e },
        ).toObject()
      }

      return new APIError(
        {
          message: parsed.message,
          statusCode: parsed.statusCode,
          isRetryable: parsed.isRetryable,
          responseHeaders: parsed.responseHeaders,
          responseBody: parsed.responseBody,
          metadata: parsed.metadata,
        },
        { cause: e },
      ).toObject()
    case e instanceof Error:
      return new NamedError.Unknown({ message: errorMessage(e) }, { cause: e }).toObject()
    default:
      try {
        const parsed = ProviderError.parseStreamError(e)
        if (parsed) {
          if (parsed.type === "context_overflow") {
            return new ContextOverflowError(
              {
                message: parsed.message,
                responseBody: parsed.responseBody,
              },
              { cause: e },
            ).toObject()
          }
          return new APIError(
            {
              message: parsed.message,
              isRetryable: parsed.isRetryable,
              responseBody: parsed.responseBody,
            },
            {
              cause: e,
            },
          ).toObject()
        }
      } catch {}
      return new NamedError.Unknown({ message: JSON.stringify(e) }, { cause: e }).toObject()
  }
}

export * as MessageV2 from "./message-v2"
export const node = LayerNode.group([Database.node])
