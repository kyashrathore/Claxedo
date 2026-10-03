import { expect } from "./fixtures"
import type { Stack } from "./stack"

export type AttentionPosition = {
  readonly sequence: number
  readonly generation: number
  readonly activitySequence: number
  readonly activityAt: number
  readonly working: boolean
  readonly awaitingInput: boolean
  readonly outcome?: { readonly sequence: number; readonly status: "completed" | "failed" | "cancelled"; readonly completedAt: number }
}

export type ReaderPosition = {
  readonly generation: number
  readonly revision: number
  readonly seenThrough: number
  readonly seenAt?: number
  readonly settledThrough?: number
}

export type ReaderRow = {
  readonly sessionId: string
  readonly workspaceId: string
  readonly title: string
  readonly attention: AttentionPosition
  readonly reader?: ReaderPosition
}

export type ReaderPage = {
  readonly items: readonly ReaderRow[]
  readonly totalKnown: number
  readonly nextAfter?: string
}

export async function readerPage(stack: Stack, query: Readonly<Record<string, string>> = {}): Promise<ReaderPage> {
  const url = new URL("/api/claxedo/session-list", stack.url)
  for (const [key, value] of Object.entries({ scope: "all", settled: "all", limit: "100", sort: "human_turn_desc", ...query })) url.searchParams.set(key, value)
  const response = await fetch(url)
  expect(response.status, "the authorized inventory read succeeds").toBe(200)
  return await response.json() as ReaderPage
}

export async function readerRow(stack: Stack, sessionId: string): Promise<ReaderRow> {
  let after: string | undefined
  do {
    const page = await readerPage(stack, after ? { after } : {})
    const row = page.items.find((item) => item.sessionId === sessionId)
    if (row) return row
    after = page.nextAfter
  } while (after)
  throw new Error(`Session ${sessionId} is absent from the complete authorized inventory`)
}

export async function writeReader(stack: Stack, row: ReaderRow, command: Readonly<Record<string, unknown>>) {
  const url = new URL(`/api/claxedo/session/${encodeURIComponent(row.sessionId)}/reader`, stack.url)
  url.searchParams.set("workspaceId", row.workspaceId)
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ generation: row.attention.generation, ...command }) })
  return { status: response.status, body: await response.json() as { ok: boolean; reason?: string; state?: ReaderPosition } }
}

export async function settleReader(stack: Stack, row: ReaderRow) {
  const result = await writeReader(stack, row, {
    kind: "settle",
    activitySequence: row.attention.activitySequence,
    outcomeSequence: row.attention.outcome?.sequence,
    revision: row.reader?.generation === row.attention.generation ? row.reader.revision : 0,
  })
  expect(result.status, "settling the exact displayed canonical row succeeds").toBe(200)
  expect(result.body.ok).toBe(true)
  return result.body.state!
}
