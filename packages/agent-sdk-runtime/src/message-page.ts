import type { AgentMessage } from "./index"
import {
  LATEST_SURFACE_MAX_INFO_BYTES as SCHEMA_LATEST_SURFACE_MAX_INFO_BYTES,
  LATEST_SURFACE_MAX_OPTIONAL_INFO_VALUE_BYTES as SCHEMA_LATEST_SURFACE_MAX_OPTIONAL_INFO_VALUE_BYTES,
  LATEST_SURFACE_MAX_PART_BYTES as SCHEMA_LATEST_SURFACE_MAX_PART_BYTES,
  LATEST_SURFACE_MAX_PARTS_BYTES as SCHEMA_LATEST_SURFACE_MAX_PARTS_BYTES,
  LATEST_SURFACE_MAX_TEXT_BYTES as SCHEMA_LATEST_SURFACE_MAX_TEXT_BYTES,
  LATEST_SURFACE_MAX_TEXT_PART_BYTES as SCHEMA_LATEST_SURFACE_MAX_TEXT_PART_BYTES,
  LATEST_SURFACE_MAX_TEXT_PARTS as SCHEMA_LATEST_SURFACE_MAX_TEXT_PARTS,
  latestSurfaceJSONBytes as schemaLatestSurfaceJSONBytes,
  projectLatestSurfaceInfo as schemaProjectLatestSurfaceInfo,
  selectLatestSurfaceTextCandidates,
} from "@opencode-ai/schema/session-message-surface"

// These contract values are deliberately exported as declaration-local
// constants. The public runtime bundles their private workspace implementation;
// npm consumers must not need the private @opencode-ai/schema package.
export const LATEST_SURFACE_MAX_INFO_BYTES = SCHEMA_LATEST_SURFACE_MAX_INFO_BYTES
export const LATEST_SURFACE_MAX_OPTIONAL_INFO_VALUE_BYTES = SCHEMA_LATEST_SURFACE_MAX_OPTIONAL_INFO_VALUE_BYTES
export const LATEST_SURFACE_MAX_PART_BYTES = SCHEMA_LATEST_SURFACE_MAX_PART_BYTES
export const LATEST_SURFACE_MAX_PARTS_BYTES = SCHEMA_LATEST_SURFACE_MAX_PARTS_BYTES
export const LATEST_SURFACE_MAX_TEXT_BYTES = SCHEMA_LATEST_SURFACE_MAX_TEXT_BYTES
export const LATEST_SURFACE_MAX_TEXT_PART_BYTES = SCHEMA_LATEST_SURFACE_MAX_TEXT_PART_BYTES
export const LATEST_SURFACE_MAX_TEXT_PARTS = SCHEMA_LATEST_SURFACE_MAX_TEXT_PARTS

export type LatestSurfaceTextBudgetCandidate = Readonly<{
  textBytes: number
  partBytes: number
}>

/**
 * An authoritative transcript-window request. Cursors are opaque to every
 * consumer.
 *
 * Semantic views are intentionally distinct from numeric pages. `latest-turn`
 * returns the complete latest turn. `latest-surface` returns at most its owning
 * user and final message; its cursor points at the final message so ordinary
 * paging restores every omitted intermediate without a second cursor protocol.
 * The surface is a first-paint projection: user `summary`, `system`, and
 * `tools` envelope fields and every non-text part are intentionally omitted as
 * whole canonical values. Text parts are never truncated or synthesized.
 */
export type AgentMessagePageInput =
  | {
      view: "latest-turn" | "latest-surface"
      limit?: never
      before?: never
    }
  | {
      view?: never
      limit: number
      before?: string
    }

/** One chronological transcript page and the cursor for the next older page. */
export type AgentMessagePage = {
  messages: AgentMessage[]
  nextCursor?: string
}

/**
 * `latest-surface` is a latency-bounded fragment, not a second transcript.
 * These byte limits are measured as UTF-8. 48 KiB preserves the largest text
 * value in the measured real-session corpus (25,115 bytes) with nearly 2x
 * headroom, while the aggregate limits prevent many individually-small parts
 * from rebuilding an unbounded first paint.
 */
function utf8Bytes(value: string) {
  return new TextEncoder().encode(value).byteLength
}

/** The byte measure producers must mirror at the persistence boundary. */
export function latestSurfaceJSONBytes(value: unknown) {
  return schemaLatestSurfaceJSONBytes(value)
}

function projectLatestSurfaceInfo<TInfo extends Record<string, unknown>>(input: TInfo): TInfo | undefined {
  return schemaProjectLatestSurfaceInfo(input)
}

type SurfaceTextCandidate = {
  messageIndex: number
  partIndex: number
  textBytes: number
  partBytes: number
}

/**
 * Select indexes from candidates already ordered newest-priority first.
 * Persistence producers use this on byte metadata before fetching/parsing the
 * chosen JSON values, so their SQL and the in-memory contract cannot drift.
 */
export function selectLatestSurfaceTextCandidateIndexes(
  candidates: readonly LatestSurfaceTextBudgetCandidate[],
) {
  return selectLatestSurfaceTextCandidates(candidates).indexes
}

function surfaceTextCandidate(part: unknown, messageIndex: number, partIndex: number): SurfaceTextCandidate | undefined {
  if (!part || typeof part !== "object") return undefined
  const value = part as { type?: unknown; text?: unknown }
  if (value.type !== "text" || typeof value.text !== "string") return undefined
  const textBytes = utf8Bytes(value.text)
  if (textBytes > LATEST_SURFACE_MAX_TEXT_PART_BYTES) return undefined
  const partBytes = latestSurfaceJSONBytes(part)
  if (partBytes > LATEST_SURFACE_MAX_PART_BYTES) return undefined
  return { messageIndex, partIndex, textBytes, partBytes }
}

/**
 * Apply the complete, producer-independent `latest-surface` budget.
 *
 * Selection walks the final message before its owning user and the newest text
 * within each message first. It takes a bounded newest-priority set, then
 * restores the producer's canonical message/part order. No selected value is
 * truncated or rewritten. A required envelope that cannot fit causes the whole surface to
 * be omitted; the deferred complete `latest-turn` is the authoritative repair.
 */
export function projectLatestSurfaceMessages<
  TInfo extends Record<string, unknown>,
  TPart,
  TMessage extends { info: TInfo; parts: TPart[] },
>(messages: readonly TMessage[]): TMessage[] {
  const info = messages.map((message) => projectLatestSurfaceInfo(message.info))
  if (info.some((value) => value === undefined)) return []

  const candidates: SurfaceTextCandidate[] = []
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    const message = messages[messageIndex]!
    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex--) {
      const candidate = surfaceTextCandidate(message.parts[partIndex], messageIndex, partIndex)
      if (candidate) candidates.push(candidate)
    }
  }

  const selected = new Set(
    selectLatestSurfaceTextCandidateIndexes(candidates)
      .map((index) => candidates[index]!)
      .map((candidate) => `${candidate.messageIndex}:${candidate.partIndex}`),
  )

  return messages.map((message, messageIndex) => ({
    ...message,
    info: info[messageIndex]!,
    parts: message.parts.filter((_part, partIndex) => selected.has(`${messageIndex}:${partIndex}`)),
  }))
}

/**
 * Project an already-selected surface message to the canonical first-paint
 * shape. This is deliberately independent of persistence and cursor policy so
 * every authoritative Claxedo producer applies the same lossless omissions.
 */
export function projectLatestSurfaceMessage<
  TInfo extends Record<string, unknown>,
  TPart,
  TMessage extends { info: TInfo; parts: TPart[] },
>(message: TMessage): TMessage | undefined {
  return projectLatestSurfaceMessages([message])[0]
}

/**
 * An authoritative message-page producer rejected the request.
 *
 * Kept in this dependency-light module so HTTP and persistence boundaries can
 * preserve producer status without importing the harness adapter catalog.
 */
export class AgentMessagePageError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = "AgentMessagePageError"
  }
}
