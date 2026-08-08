import type { UsageProvenance } from "../provenance"

type NativeRow = {
  app: string
  source: string
  model: string
  bucket_start: number
  native_session_id: string
  input_tokens: number
  output_tokens: number
  reasoning_output_tokens: number
  cached_input_tokens: number
  cache_creation_input_tokens: number
}

export type ExternalUsageBucket = {
  app: string
  model: string
  bucketStart: number
  nativeSessionId: string
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
}

export type LocalHistorySnapshot = {
  rows: ExternalUsageBucket[]
  coverage: Array<{ source: string; status: "available" | "degraded" | "unavailable" | "unsupported"; error?: string }>
  classifiedClaxedo: number
  unclassified: number
}

export async function scanTokenTrackerLocalHistory(input: {
  sourceHome: string
  stateDir: string
  since: number
  until: number
  sources?: string[]
  classify: (input: { source?: string; nativeSessionId?: string; observedAt: number }) => UsageProvenance | Promise<UsageProvenance>
}): Promise<LocalHistorySnapshot> {
  const scanner = await import("tokentracker-cli/src/lib/embedded-history.js")
  const result = await scanner.scanLocalHistory({
    sourceHome: input.sourceHome,
    stateDir: input.stateDir,
    since: input.since,
    until: input.until,
    ...(input.sources ? { sources: input.sources } : {}),
    upload: false,
    telemetry: false,
    classify: async (event) => await input.classify({
      source: event.source,
      nativeSessionId: event.nativeSessionId,
      observedAt: event.observedAt,
    }),
  })
  return {
    rows: result.rows.map((row: NativeRow) => ({
      app: row.app,
      model: row.model,
      bucketStart: row.bucket_start,
      nativeSessionId: row.native_session_id,
      tokens: {
        input: row.input_tokens,
        output: row.output_tokens,
        reasoning: row.reasoning_output_tokens,
        cacheRead: row.cached_input_tokens,
        cacheWrite: row.cache_creation_input_tokens,
      },
    })),
    coverage: result.coverage.map((item) => ({
      source: item.source,
      status: item.status,
      ...(item.error ? { error: item.error } : {}),
    })),
    classifiedClaxedo: result.classified_claxedo,
    unclassified: result.unclassified,
  }
}
