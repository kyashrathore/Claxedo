import { z } from "zod"
import { ChangeCursorSchema, type ChangeCursor } from "./commands"
import type { WorkGraphSnapshotPage } from "./records"

const prefix = "wgsp1"
const maxLength = 512
const recordTypes = new Set([
  "workgraph",
  "stream",
  "outcome",
  "work_item",
  "attempt",
  "decision",
  "recap",
  "admission_proposal",
])

export type SnapshotResumeCursorErrorReason = "invalid" | "owner_mismatch" | "invalidated"

export const SnapshotResumeCursorSchema = z.string().trim().min(1).max(maxLength).brand("SnapshotResumeCursor")
export type SnapshotResumeCursor = z.infer<typeof SnapshotResumeCursorSchema>

/** Signals that a snapshot page chain must be restarted from its first page. */
export class SnapshotResumeCursorError extends Error {
  readonly code = "cursor_invalid" as const

  constructor(readonly reason: SnapshotResumeCursorErrorReason) {
    super("Snapshot resume cursor is no longer valid")
    this.name = "SnapshotResumeCursorError"
  }
}

export type DecodedSnapshotResumeCursor = Readonly<{
  organizationId: string
  ownerUserId: string
  snapshotCursor: ChangeCursor
  offset: number
  capturedAt: number
  position: SnapshotCursorPosition
}>

export type SnapshotCursorPosition = Readonly<{
  createdAt: number
  recordType: string
  id: string
}>

export function createSnapshotResumeCursor(input: Readonly<{
  organizationId: string
  ownerUserId: string
  snapshotCursor: string
  offset: number
  capturedAt: number
  position: SnapshotCursorPosition
}>): SnapshotResumeCursor {
  const cursor = `${prefix}:${encodeURIComponent(input.organizationId)}:${encodeURIComponent(input.ownerUserId)}:${encodeURIComponent(input.snapshotCursor)}:${input.offset}:${input.capturedAt}:${input.position.createdAt}:${encodeURIComponent(input.position.recordType)}:${encodeURIComponent(input.position.id)}`
  if (cursor.length > maxLength) throw new SnapshotResumeCursorError("invalid")
  return cursor as SnapshotResumeCursor
}

export function readSnapshotResumeCursor(
  cursor: string,
  organizationId: string,
  ownerUserId: string,
  currentSnapshotCursor: string,
): DecodedSnapshotResumeCursor {
  if (cursor.length > maxLength) throw new SnapshotResumeCursorError("invalid")
  const parts = cursor.split(":")
  if (parts.length !== 9 || parts[0] !== prefix) throw new SnapshotResumeCursorError("invalid")
  if (decodeOwner(parts[1]!) !== organizationId) throw new SnapshotResumeCursorError("owner_mismatch")
  const encodedOwner = parts[2]!
  const cursorOwner = decodeOwner(encodedOwner)
  if (cursorOwner !== ownerUserId) throw new SnapshotResumeCursorError("owner_mismatch")
  const snapshotCursor = ChangeCursorSchema.parse(decodeComponent(parts[3]!))
  const offset = integer(parts[4])
  const capturedAt = integer(parts[5])
  const createdAt = integer(parts[6])
  const recordType = decodeComponent(parts[7]!)
  const id = decodeComponent(parts[8]!)
  if (!recordTypes.has(recordType)) throw new SnapshotResumeCursorError("invalid")
  if (snapshotCursor !== currentSnapshotCursor) throw new SnapshotResumeCursorError("invalidated")
  return {
    organizationId,
    ownerUserId,
    snapshotCursor,
    offset,
    capturedAt,
    position: { createdAt, recordType, id },
  }
}

export class WorkGraphSnapshotAggregationError extends Error {
  readonly code = "snapshot_invalid" as const

  constructor(readonly reason: "bounds" | "metadata" | "order" | "duplicate") {
    super("WorkGraph snapshot pages cannot be combined safely")
    this.name = "WorkGraphSnapshotAggregationError"
  }
}

export async function collectWorkGraphSnapshotPages(input: Readonly<{
  page: (after?: SnapshotResumeCursor) => Promise<WorkGraphSnapshotPage>
  isCursorInvalid: (error: unknown) => boolean
  maxPages?: number
  maxRecords?: number
}>) {
  const limits = {
    pages: input.maxPages ?? 100,
    records: input.maxRecords ?? 10_000,
  }
  for (const restart of [false, true]) {
    try {
      return await collectSnapshotPass(input.page, limits)
    } catch (error) {
      if (!restart && input.isCursorInvalid(error)) continue
      throw error
    }
  }
  throw new WorkGraphSnapshotAggregationError("bounds")
}

async function collectSnapshotPass(
  page: (after?: SnapshotResumeCursor) => Promise<WorkGraphSnapshotPage>,
  limits: Readonly<{ pages: number; records: number }>,
): Promise<WorkGraphSnapshotPage> {
  const records: WorkGraphSnapshotPage["records"] = []
  const references: WorkGraphSnapshotPage["references"] = []
  const identities = new Set<string>()
  const cursors = new Set<string>()
  let after: SnapshotResumeCursor | undefined
  let metadata: Pick<WorkGraphSnapshotPage, "snapshotCursor" | "capturedAt"> | undefined

  for (let pageNumber = 0; pageNumber < limits.pages; pageNumber++) {
    const current = await page(after)
    metadata ??= { snapshotCursor: current.snapshotCursor, capturedAt: current.capturedAt }
    requireStableSnapshot(current, metadata)
    current.records.forEach((record, index) => {
      const reference = current.references[index]
      if (!reference || reference.sequence !== records.length + 1) throw new WorkGraphSnapshotAggregationError("order")
      if (reference.resource.type !== record.recordType || reference.resource.id !== record.id || reference.version !== record.version) {
        throw new WorkGraphSnapshotAggregationError("metadata")
      }
      const identity = `${record.recordType}:${record.id}`
      if (identities.has(identity)) throw new WorkGraphSnapshotAggregationError("duplicate")
      identities.add(identity)
      records.push(record)
      references.push(reference)
    })
    if (records.length > limits.records) throw new WorkGraphSnapshotAggregationError("bounds")
    if (!current.hasMore) {
      if (current.nextCursor) throw new WorkGraphSnapshotAggregationError("metadata")
      return { ...metadata, records, references, hasMore: false }
    }
    if (!current.nextCursor || current.records.length === 0 || cursors.has(current.nextCursor)) {
      throw new WorkGraphSnapshotAggregationError("metadata")
    }
    cursors.add(current.nextCursor)
    after = current.nextCursor
  }
  throw new WorkGraphSnapshotAggregationError("bounds")
}

function requireStableSnapshot(
  page: WorkGraphSnapshotPage,
  expected: Pick<WorkGraphSnapshotPage, "snapshotCursor" | "capturedAt">,
) {
  if (page.snapshotCursor !== expected.snapshotCursor || page.capturedAt !== expected.capturedAt) {
    throw new WorkGraphSnapshotAggregationError("metadata")
  }
  if (page.records.length !== page.references.length) throw new WorkGraphSnapshotAggregationError("metadata")
}

export function compareSnapshotCursorPosition(left: SnapshotCursorPosition, right: SnapshotCursorPosition) {
  return left.createdAt - right.createdAt || left.recordType.localeCompare(right.recordType) || left.id.localeCompare(right.id)
}

function decodeOwner(value: string) {
  return decodeComponent(value)
}

function decodeComponent(value: string) {
  try {
    const decoded = decodeURIComponent(value)
    if (!decoded || encodeURIComponent(decoded) !== value) throw new SnapshotResumeCursorError("invalid")
    return decoded
  } catch (error) {
    if (error instanceof SnapshotResumeCursorError) throw error
    throw new SnapshotResumeCursorError("invalid")
  }
}

function integer(value: string | undefined) {
  const parsed = Number(value)
  if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw new SnapshotResumeCursorError("invalid")
  }
  return parsed
}
