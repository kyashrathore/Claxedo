/**
 * The perf mock's transcript-page contract.
 *
 * The product's authoritative owner of this contract is
 * `packages/agent-sdk-runtime/src/message-page.ts` (`AgentMessagePageInput`),
 * and three in-repo producers implement it identically:
 *
 *   - `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts`
 *     (`SessionHttpApi.messages`)
 *   - `packages/workspace-runtime/src/store.ts` (`getMessagePage`)
 *   - `packages/claxedo-server-core/src/session/message-replay.ts`
 *
 * All three reject `view` combined with `limit`/`before`, and all three answer
 * `view=latest-surface` with AT MOST the latest turn's owning user message and
 * its final message — a first-paint fragment, not a transcript — plus a
 * `X-Next-Cursor` that points at the final message so ordinary numeric paging
 * restores every omitted intermediate.
 *
 * This module exists because the mock previously read only `limit` and
 * answered `view=latest-surface` with an 80-message page, i.e. with a response
 * no product server can produce. Every session-switch measurement taken
 * against that mock attributed a fictional payload to the cold switch.
 *
 * The byte budgets below mirror `packages/schema/src/session-message-surface.ts`
 * (perf-harness is not a workspace member of the root install and cannot import
 * it; keep the two in sync when the contract moves).
 */

export type MockMessagePageView = "latest-turn" | "latest-surface"

export type MockMessagePageRequest =
  | { view: MockMessagePageView; limit?: never; before?: never }
  | { view?: never; limit?: number; before?: string }

/** `MAX_MESSAGE_PAGE_LIMIT`, claxedo-server/src/session/message-page.ts. */
export const MOCK_MESSAGE_PAGE_MAX_LIMIT = 500
/**
 * The page size the mock answers an unparameterised read with. The product
 * servers return the WHOLE transcript there; no in-repo client issues that
 * request (`SessionMessagePageRequest` is a required union), so the mock keeps
 * its historical bounded default rather than materialising a 20k-message
 * fixture for a request nothing makes.
 */
export const MOCK_MESSAGE_PAGE_DEFAULT_LIMIT = 80

/** A producer-status rejection, mirroring `AgentMessagePageError`. */
export class MockMessagePageError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = "MockMessagePageError"
  }
}

/** Mirrors `parseMessagePageInput` (claxedo-server) and the opencode handler's guards. */
export function parseMockMessagePageRequest(params: URLSearchParams): MockMessagePageRequest {
  const view = params.get("view") ?? undefined
  const limit = params.get("limit") ?? undefined
  const before = params.get("before") ?? undefined
  if (view !== undefined) {
    if ((view !== "latest-turn" && view !== "latest-surface") || limit !== undefined || before !== undefined) {
      throw new MockMessagePageError(
        400,
        "view must be latest-turn or latest-surface and cannot be combined with limit or before",
      )
    }
    return { view }
  }
  if (limit === undefined && before === undefined) return {}
  if (limit === undefined || !/^[1-9]\d*$/.test(limit)) {
    throw new MockMessagePageError(400, `limit must be an integer between 1 and ${MOCK_MESSAGE_PAGE_MAX_LIMIT}`)
  }
  const parsed = Number(limit)
  if (!Number.isSafeInteger(parsed) || parsed > MOCK_MESSAGE_PAGE_MAX_LIMIT) {
    throw new MockMessagePageError(400, `limit must be an integer between 1 and ${MOCK_MESSAGE_PAGE_MAX_LIMIT}`)
  }
  if (before !== undefined && before.length === 0) {
    throw new MockMessagePageError(400, "before must be a non-empty cursor")
  }
  return { limit: parsed, ...(before === undefined ? {} : { before }) }
}

export type MockMessagePageSelection = {
  /** Transcript indexes to materialise, oldest first. */
  indexes: number[]
  /** Value for `X-Next-Cursor`; absent when nothing older remains. */
  cursor?: string
  /** Whether the selected rows must be projected to the first-paint surface. */
  surface: boolean
}

/**
 * Choose the transcript window for one request.
 *
 * Index-level rather than row-level on purpose: the caller owns row shape and
 * only materialises the rows this returns, so a two-message surface read never
 * builds the 78 rows it would then throw away.
 */
export function selectMockMessagePage(input: {
  request: MockMessagePageRequest
  total: number
  messageID: (index: number) => string
  indexOfMessageID: (id: string) => number | undefined
  role: (index: number) => "user" | "assistant"
}): MockMessagePageSelection {
  const { total } = input
  if (total <= 0) return { indexes: [], surface: false }

  const view = input.request.view
  if (view !== undefined) {
    let boundary = -1
    for (let index = total - 1; index >= 0; index--) {
      if (input.role(index) === "user") {
        boundary = index
        break
      }
    }
    if (boundary < 0) {
      throw new MockMessagePageError(409, "Latest turn boundary is unavailable")
    }
    const final = total - 1
    if (view === "latest-turn") {
      return {
        indexes: range(boundary, final),
        ...(boundary > 0 ? { cursor: input.messageID(boundary) } : {}),
        surface: false,
      }
    }
    // The surface carries only the turn's semantic anchors. Its cursor points
    // at the FINAL message, so `before=<cursor>` restores the intermediates it
    // omitted without needing a second cursor protocol.
    return {
      indexes: boundary === final ? [boundary] : [boundary, final],
      ...(final > 0 ? { cursor: input.messageID(final) } : {}),
      surface: true,
    }
  }

  const end = input.request.before === undefined ? total : cursorIndex(input, input.request.before)
  const limit = input.request.limit ?? MOCK_MESSAGE_PAGE_DEFAULT_LIMIT
  const start = Math.max(0, end - limit)
  return {
    indexes: range(start, end - 1),
    ...(start > 0 ? { cursor: input.messageID(start) } : {}),
    surface: false,
  }
}

/**
 * Apply the `latest-surface` projection to an already-selected page: every
 * text part, whole, and nothing else. Mirrors `projectLatestSurfaceMessages`
 * in agent-sdk-runtime/src/message-page.ts.
 */
export function projectMockSurfacePage<
  TRow extends { info: Record<string, unknown>; parts: Array<{ type?: unknown; text?: unknown }> },
>(rows: readonly TRow[]): TRow[] {
  return rows.map((row) => ({ ...row, parts: row.parts.filter((part) => part.type === "text") }))
}

function cursorIndex(
  input: { total: number; indexOfMessageID: (id: string) => number | undefined },
  before: string,
) {
  const index = input.indexOfMessageID(before)
  if (index === undefined || index < 0 || index > input.total) {
    throw new MockMessagePageError(400, `before is not a cursor this transcript produced: ${before}`)
  }
  return index
}

function range(from: number, to: number) {
  const length = Math.max(0, to - from + 1)
  return Array.from({ length }, (_, offset) => from + offset)
}

