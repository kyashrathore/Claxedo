import type { AgentMessage } from "./index"

// Claxedo owns the latency-bounded presentation contract. Keeping these limits
// here prevents the runtime's public API from depending on a provider schema.
export const LATEST_SURFACE_MAX_TEXT_PART_BYTES = 48 * 1024
export const LATEST_SURFACE_MAX_PART_BYTES = 56 * 1024
export const LATEST_SURFACE_MAX_TEXT_BYTES = 64 * 1024
export const LATEST_SURFACE_MAX_PARTS_BYTES = 80 * 1024
export const LATEST_SURFACE_MAX_TEXT_PARTS = 16
export const LATEST_SURFACE_MAX_OPTIONAL_INFO_VALUE_BYTES = 8 * 1024
export const LATEST_SURFACE_MAX_INFO_BYTES = 16 * 1024

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
  try {
    const encoded = JSON.stringify(value)
    return encoded === undefined ? Number.POSITIVE_INFINITY : utf8Bytes(encoded)
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function projectLatestSurfaceInfo<TInfo extends Record<string, unknown>>(input: TInfo): TInfo | undefined {
  const info: Record<string, unknown> = { ...input }
  if (info.role === "user") {
    delete info.summary
    delete info.system
    delete info.tools
  }
  if (
    info.role === "assistant" &&
    "error" in info &&
    latestSurfaceJSONBytes(info.error) > LATEST_SURFACE_MAX_OPTIONAL_INFO_VALUE_BYTES
  ) {
    delete info.error
  }
  if (latestSurfaceJSONBytes(info) > LATEST_SURFACE_MAX_INFO_BYTES) return undefined
  return info as TInfo
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
  const selected: number[] = []
  let textBytes = 0
  let partBytes = 0
  for (const [index, candidate] of candidates.entries()) {
    if (selected.length >= LATEST_SURFACE_MAX_TEXT_PARTS) break
    if (candidate.textBytes > LATEST_SURFACE_MAX_TEXT_PART_BYTES) continue
    if (candidate.partBytes > LATEST_SURFACE_MAX_PART_BYTES) continue
    if (textBytes + candidate.textBytes > LATEST_SURFACE_MAX_TEXT_BYTES) continue
    if (partBytes + candidate.partBytes > LATEST_SURFACE_MAX_PARTS_BYTES) continue
    selected.push(index)
    textBytes += candidate.textBytes
    partBytes += candidate.partBytes
  }
  return selected
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
