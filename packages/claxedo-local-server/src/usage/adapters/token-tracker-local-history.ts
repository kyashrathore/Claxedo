import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import type { UsageProvenance } from "@claxedo/server-core/usage/provenance"

export type ExternalUsageBucket = {
  app: string
  provider: string
  model: string
  bucketStart: number
  nativeSessionId: string
  turnCount: number
  tokens: { input: number | null; output: number | null; reasoning: number | null; cacheRead: number | null; cacheWrite: number | null }
}

export type LocalHistorySnapshot = {
  rows: ExternalUsageBucket[]
  totalRows: ExternalUsageBucket[]
  coverage: Array<{ source: string; status: "available" | "degraded" | "unavailable" | "unsupported"; error?: string }>
  classifiedClaxedo: number
  unclassified: number
}

const CACHE_VERSION = 8
const CACHE_TTL_MS = 5 * 60_000
const CACHE_FILE = "local-history-v8.json"
const scans = new Map<string, Promise<LocalHistorySnapshot>>()

type EmbeddedHistoryRow = {
  app: string
  provider: string
  model: string
  bucket_start: number
  native_session_id: string
  event_count: number
  input_tokens: number | null
  output_tokens: number | null
  reasoning_output_tokens: number | null
  cached_input_tokens: number | null
  cache_creation_input_tokens: number | null
}

type TokenTrackerHistoryModule = {
  scanLocalHistory(options: {
    sourceHome: string
    stateDir: string
    since: number
    until: number
    sources?: string[]
    /**
     * Extra absolute dirs scanned for opencode sqlite DBs beyond
     * `$sourceHome/.local/share/opencode` — the embedded engine keeps
     * OPENCODE_DB under Claxedo's own data dir, never under $HOME.
     */
    opencodeRoots?: string[]
    upload: false
    telemetry: false
    classify(input: { source?: string; nativeSessionId?: string; observedAt: number }): UsageProvenance | Promise<UsageProvenance>
  }): Promise<{
    rows: EmbeddedHistoryRow[]
    total_rows: EmbeddedHistoryRow[]
    coverage: Array<{ source: string; status: "available" | "degraded" | "unavailable" | "unsupported"; error?: string | null }>
    classified_claxedo: number
    unclassified: number
  }>
}

type CachedLocalHistory = {
  version: typeof CACHE_VERSION
  key: string
  createdAt: number
  snapshot: LocalHistorySnapshot
}

function scanKey(input: {
  sourceHome: string
  since: number
  until: number
  sources?: string[]
  opencodeRoots?: string[]
  classificationKey: string
}) {
  return createHash("sha256").update(JSON.stringify({
    sourceHome: input.sourceHome,
    since: input.since,
    until: input.until,
    sources: (input.sources ?? []).toSorted(),
    opencodeRoots: (input.opencodeRoots ?? []).toSorted(),
    classificationKey: input.classificationKey,
  })).digest("hex")
}

async function readCached(stateDir: string, key: string) {
  try {
    const cached = JSON.parse(await fs.readFile(path.join(stateDir, CACHE_FILE), "utf8")) as CachedLocalHistory
    if (cached.version !== CACHE_VERSION || cached.key !== key || Date.now() - cached.createdAt > CACHE_TTL_MS) return
    return cached.snapshot
  } catch {
    return
  }
}

async function writeCached(stateDir: string, key: string, snapshot: LocalHistorySnapshot) {
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 })
  const target = path.join(stateDir, CACHE_FILE)
  const temporary = `${target}.${process.pid}.${key}.tmp`
  const cached: CachedLocalHistory = { version: CACHE_VERSION, key, createdAt: Date.now(), snapshot }
  await fs.writeFile(temporary, JSON.stringify(cached), { mode: 0o600 })
  await fs.rename(temporary, target)
}

export async function scanTokenTrackerLocalHistory(input: {
  sourceHome: string
  stateDir: string
  since: number
  until: number
  sources?: string[]
  /** See TokenTrackerHistoryModule.scanLocalHistory — embedded-engine DB dirs. */
  opencodeRoots?: string[]
  classificationKey: string
  refresh?: boolean
  classify: (input: { source?: string; nativeSessionId?: string; observedAt: number }) => UsageProvenance | Promise<UsageProvenance>
}): Promise<LocalHistorySnapshot> {
  const key = scanKey(input)
  const active = scans.get(key)
  if (active) return await active
  const scan = (async () => {
    if (!input.refresh) {
      const cached = await readCached(input.stateDir, key)
      if (cached) return cached
    }
    // @ts-expect-error TokenTracker ships no declarations; the exact embedded
    // scanner contract is defined above and verified against the pinned patch.
    const scanner = await import("tokentracker-cli/src/lib/rollout.js") as TokenTrackerHistoryModule
    const result = await scanner.scanLocalHistory({
      sourceHome: input.sourceHome,
      stateDir: input.stateDir,
      since: input.since,
      until: input.until,
      ...(input.sources ? { sources: input.sources } : {}),
      ...(input.opencodeRoots ? { opencodeRoots: input.opencodeRoots } : {}),
      upload: false,
      telemetry: false,
      classify: async (event) => await input.classify({
        source: event.source,
        nativeSessionId: event.nativeSessionId,
        observedAt: event.observedAt,
      }),
    })
    const mapRow = (row: EmbeddedHistoryRow): ExternalUsageBucket => ({
      app: row.app,
      provider: row.provider,
      model: row.model,
      bucketStart: row.bucket_start,
      nativeSessionId: row.native_session_id,
      turnCount: row.event_count,
      tokens: {
        input: row.input_tokens,
        output: row.output_tokens,
        reasoning: row.reasoning_output_tokens,
        cacheRead: row.cached_input_tokens,
        cacheWrite: row.cache_creation_input_tokens,
      },
    })
    const snapshot: LocalHistorySnapshot = {
      rows: result.rows.map(mapRow),
      totalRows: result.total_rows.map(mapRow),
      coverage: result.coverage.map((item) => ({
        source: item.source,
        status: item.status,
        ...(item.error ? { error: item.error } : {}),
      })),
      classifiedClaxedo: result.classified_claxedo,
      unclassified: result.unclassified,
    }
    await writeCached(input.stateDir, key, snapshot)
    return snapshot
  })()
  scans.set(key, scan)
  try {
    return await scan
  } finally {
    if (scans.get(key) === scan) scans.delete(key)
  }
}
