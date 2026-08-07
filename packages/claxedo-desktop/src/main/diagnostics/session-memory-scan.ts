import { existsSync } from "node:fs"
import type { LocalDiagnostics } from "@claxedo/app/process-diagnostics-contract"

export type SessionMemoryDatabase = {
  prepare(sql: string): { all(): unknown[] }
  close(): void
}

export type SessionMemoryScanPaths = {
  databases: Array<{ path: string; profile: string }>
}

export async function scanSessionMemoryStores(input: {
  paths: SessionMemoryScanPaths
  warmSessions: LocalDiagnostics.WarmSessionMemory[]
  openDatabase?: (path: string) => SessionMemoryDatabase
  now?: () => number
}) {
  const startedAt = (input.now ?? Date.now)()
  const scans = await Promise.all(
    input.paths.databases.map((database) => scanDatabase(database, input.openDatabase)),
  )
  const sessions = scans.flatMap((scan) => scan.sessions).sort(
    (left, right) => right.buckets.totalBytes - left.buckets.totalBytes || left.sessionId.localeCompare(right.sessionId),
  ).slice(0, 10_000)
  const stored = sumBuckets(scans.map((scan) => scan.source.buckets))
  const resident = sumBuckets(input.warmSessions.map((session) => session.buckets))
  const scannedAt = (input.now ?? Date.now)()
  return {
    version: 1 as const,
    scannedAt,
    durationMs: Math.max(0, scannedAt - startedAt),
    stored,
    resident,
    sources: scans.map((scan) => scan.source),
    sessions,
    warmSessions: input.warmSessions,
  } satisfies LocalDiagnostics.SessionMemoryScanResult
}

async function scanDatabase(
  input: { path: string; profile: string },
  openDatabase: ((path: string) => SessionMemoryDatabase) | undefined,
) {
  const harness = "claxedo" as const
  if (!existsSync(input.path) || !openDatabase) return emptyScan(harness, input.profile, "unavailable")
  let database: SessionMemoryDatabase | undefined
  try {
    database = openDatabase(input.path)
    const rows = database.prepare(databaseQuery).all() as Array<{
      id: string
      title?: string
      updatedAt?: number
      chatBytes?: number
      imageBytes?: number
      compactionBytes?: number
      totalBytes?: number
    }>
    const sessions = rows.map((row) => ({
      sessionId: row.id,
      ...(row.title ? { title: safeLabel(row.title) } : {}),
      harness,
      profile: safeLabel(input.profile),
      ...(row.updatedAt ? { updatedAt: Math.max(0, Math.floor(row.updatedAt)) } : {}),
      buckets: normalizeBuckets(row),
    } satisfies LocalDiagnostics.StoredSessionMemory))
    return completedScan(harness, input.profile, sessions)
  } catch {
    return emptyScan(harness, input.profile, "failed")
  } finally {
    database?.close()
  }
}

const databaseQuery = `
WITH payload AS (
  SELECT session_id AS sessionId, length(data) AS totalBytes,
    CASE
      WHEN json_extract(data, '$.type') = 'file' AND json_extract(data, '$.mime') LIKE 'image/%'
        THEN length(coalesce(json_extract(data, '$.url'), ''))
      WHEN json_extract(data, '$.type') = 'tool'
        THEN coalesce((SELECT sum(length(coalesce(json_extract(value, '$.url'), ''))) FROM json_each(data, '$.state.attachments') WHERE json_extract(value, '$.mime') LIKE 'image/%'), 0)
      ELSE 0
    END AS imageBytes,
    CASE WHEN json_extract(data, '$.type') = 'compaction' THEN length(data) ELSE 0 END AS compactionBytes
  FROM part
  UNION ALL
  SELECT session_id, length(data), 0, 0 FROM message
  UNION ALL
  SELECT aggregate_id, length(data),
    CASE
      WHEN type = 'message.part.updated.1' AND json_extract(data, '$.part.type') = 'file' AND json_extract(data, '$.part.mime') LIKE 'image/%'
        THEN length(coalesce(json_extract(data, '$.part.url'), ''))
      ELSE 0
    END,
    CASE WHEN type = 'message.part.updated.1' AND json_extract(data, '$.part.type') = 'compaction' THEN length(data) ELSE 0 END
  FROM event
), totals AS (
  SELECT sessionId,
    sum(totalBytes) AS totalBytes,
    sum(imageBytes) AS imageBytes,
    sum(compactionBytes) AS compactionBytes
  FROM payload GROUP BY sessionId
)
SELECT session.id, session.title, session.time_updated AS updatedAt,
  max(0, coalesce(totals.totalBytes, 0) - coalesce(totals.imageBytes, 0) - coalesce(totals.compactionBytes, 0)) AS chatBytes,
  coalesce(totals.imageBytes, 0) AS imageBytes,
  coalesce(totals.compactionBytes, 0) AS compactionBytes,
  coalesce(totals.totalBytes, 0) AS totalBytes
FROM session LEFT JOIN totals ON totals.sessionId = session.id
ORDER BY totalBytes DESC`

function completedScan(
  harness: LocalDiagnostics.SessionMemoryHarness,
  profile: string,
  sessions: LocalDiagnostics.StoredSessionMemory[],
) {
  return {
    source: {
      harness,
      profile: safeLabel(profile),
      state: "scanned" as const,
      sessionCount: sessions.length,
      buckets: sumBuckets(sessions.map((session) => session.buckets)),
    },
    sessions,
  }
}

function emptyScan(
  harness: LocalDiagnostics.SessionMemoryHarness,
  profile: string,
  state: "unavailable" | "failed",
) {
  return {
    source: { harness, profile: safeLabel(profile), state, sessionCount: 0, buckets: zeroBuckets() },
    sessions: [] as LocalDiagnostics.StoredSessionMemory[],
  }
}

function normalizeBuckets(input: Partial<LocalDiagnostics.SessionMemoryBuckets>) {
  const chatBytes = finite(input.chatBytes)
  const imageBytes = finite(input.imageBytes)
  const compactionBytes = finite(input.compactionBytes)
  return { chatBytes, imageBytes, compactionBytes, totalBytes: chatBytes + imageBytes + compactionBytes }
}

function sumBuckets(buckets: LocalDiagnostics.SessionMemoryBuckets[]) {
  return buckets.reduce((total, value) => ({
    chatBytes: total.chatBytes + value.chatBytes,
    imageBytes: total.imageBytes + value.imageBytes,
    compactionBytes: total.compactionBytes + value.compactionBytes,
    totalBytes: total.totalBytes + value.totalBytes,
  }), zeroBuckets())
}

function zeroBuckets(): LocalDiagnostics.SessionMemoryBuckets {
  return { chatBytes: 0, imageBytes: 0, compactionBytes: 0, totalBytes: 0 }
}

function finite(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function safeLabel(value: string) {
  return value.replace(/[\r\n\t]+/g, " ").trim().slice(0, 256) || "Untitled session"
}
