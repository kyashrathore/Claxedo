import { createReadStream, existsSync, statSync } from "node:fs"
import { opendir } from "node:fs/promises"
import { basename, join } from "node:path"
import { createInterface } from "node:readline"
import type { LocalDiagnostics } from "@claxedo/app/process-diagnostics-contract"

export type SessionMemoryDatabase = {
  prepare(sql: string): { all(): unknown[] }
  close(): void
}

export type SessionMemoryScanPaths = {
  codexHome: string
  claudeHome: string
  databases: Array<{ path: string; profile: string }>
}

export async function scanSessionMemoryStores(input: {
  paths: SessionMemoryScanPaths
  warmSessions: LocalDiagnostics.WarmSessionMemory[]
  openDatabase?: (path: string) => SessionMemoryDatabase
  now?: () => number
}) {
  const startedAt = (input.now ?? Date.now)()
  const scans = await Promise.all([
    scanCodex(input.paths.codexHome),
    scanClaude(input.paths.claudeHome),
    ...input.paths.databases.map((database) => scanDatabase(database, input.openDatabase)),
  ])
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

async function scanCodex(home: string) {
  const harness = "codex" as const
  if (!existsSync(home)) return emptyScan(harness, "native", "unavailable")
  try {
    const titles = await codexTitles(join(home, "session_index.jsonl"))
    const files = (await Promise.all([
      jsonlFiles(join(home, "sessions")),
      jsonlFiles(join(home, "archived_sessions")),
    ])).flat()
    const sessions = await mapSeries(files, async (file) => {
      const result = await scanJsonl(file, "codex")
      const sessionId = basename(file, ".jsonl").match(/([0-9a-f]{8}-[0-9a-f-]{27})$/i)?.[1] ?? basename(file, ".jsonl")
      return {
        sessionId,
        ...(titles.get(sessionId) ? { title: safeLabel(titles.get(sessionId)!) } : {}),
        harness,
        profile: "native",
        updatedAt: Math.max(0, Math.floor(statSync(file).mtimeMs)),
        buckets: result.buckets,
      } satisfies LocalDiagnostics.StoredSessionMemory
    })
    return completedScan(harness, "native", sessions)
  } catch {
    return emptyScan(harness, "native", "failed")
  }
}

async function scanClaude(home: string) {
  const harness = "claude" as const
  const projects = join(home, "projects")
  if (!existsSync(projects)) return emptyScan(harness, "native", "unavailable")
  try {
    const files = await jsonlFiles(projects)
    const sessions = await mapSeries(files, async (file) => {
      const result = await scanJsonl(file, "claude")
      return {
        sessionId: basename(file, ".jsonl"),
        ...(result.title ? { title: safeLabel(result.title) } : {}),
        harness,
        profile: "native",
        updatedAt: Math.max(0, Math.floor(statSync(file).mtimeMs)),
        buckets: result.buckets,
      } satisfies LocalDiagnostics.StoredSessionMemory
    })
    return completedScan(harness, "native", sessions)
  } catch {
    return emptyScan(harness, "native", "failed")
  }
}

async function scanJsonl(file: string, harness: "codex" | "claude") {
  const buckets = zeroBuckets()
  let title: string | undefined
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  for await (const line of lines) {
    const totalBytes = Buffer.byteLength(line) + 1
    const imageBytes = embeddedImageBytes(line, harness)
    const remaining = Math.max(0, totalBytes - imageBytes)
    buckets.imageBytes += imageBytes
    if (compactionLine(line, harness)) buckets.compactionBytes += remaining
    else buckets.chatBytes += remaining
    if (harness === "claude" && (line.includes('"customTitle"') || line.includes('"aiTitle"'))) {
      try {
        const item = JSON.parse(line) as { customTitle?: unknown; aiTitle?: unknown }
        const next = typeof item.customTitle === "string" ? item.customTitle : typeof item.aiTitle === "string" ? item.aiTitle : undefined
        if (next) title = next
      } catch {}
    }
  }
  buckets.totalBytes = buckets.chatBytes + buckets.imageBytes + buckets.compactionBytes
  return { buckets, title }
}

function embeddedImageBytes(line: string, harness: "codex" | "claude") {
  if (!line.includes("data:image/") && (harness !== "claude" || !line.includes('"base64"'))) return 0
  try {
    return imageStrings(JSON.parse(line), false)
  } catch {
    return 0
  }
}

function imageStrings(value: unknown, imageContext: boolean): number {
  if (typeof value === "string") {
    if (value.startsWith("data:image/")) return Buffer.byteLength(value)
    return imageContext && value.length > 256 && /^[A-Za-z0-9+/]+=*$/.test(value) ? Buffer.byteLength(value) : 0
  }
  if (!value || typeof value !== "object") return 0
  if (Array.isArray(value)) return value.reduce((total, item) => total + imageStrings(item, imageContext), 0)
  const item = value as Record<string, unknown>
  const mime = typeof item.mime === "string"
    ? item.mime
    : typeof item.media_type === "string"
      ? item.media_type
      : typeof item.type === "string" && item.type.startsWith("image/")
        ? item.type
        : undefined
  const next = imageContext || item.type === "image" || mime?.startsWith("image/") === true || ("base64" in item && "file" in item)
  return Object.values(item).reduce<number>((total, child) => total + imageStrings(child, next), 0)
}

function compactionLine(line: string, harness: "codex" | "claude") {
  if (harness === "codex") return line.includes('"type":"compacted"')
  return line.includes('"subtype":"compact_boundary"') ||
    line.includes('"isCompactSummary":true') ||
    line.includes('"type":"summary"')
}

async function codexTitles(file: string) {
  const titles = new Map<string, string>()
  if (!existsSync(file)) return titles
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  for await (const line of lines) {
    try {
      const item = JSON.parse(line) as { id?: unknown; thread_name?: unknown }
      if (typeof item.id === "string" && typeof item.thread_name === "string") titles.set(item.id, item.thread_name)
    } catch {}
  }
  return titles
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

async function jsonlFiles(root: string) {
  if (!existsSync(root)) return []
  const files: string[] = []
  const visit = async (directory: string) => {
    const entries = await opendir(directory)
    for await (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(path)
        continue
      }
      if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path)
    }
  }
  await visit(root)
  return files.sort()
}

async function mapSeries<T, U>(items: T[], fn: (item: T) => Promise<U>) {
  const result: U[] = []
  for (const item of items) result.push(await fn(item))
  return result
}

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
