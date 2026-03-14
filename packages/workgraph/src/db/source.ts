import type { RunSource, RunSourceInput } from "../model/types"

/**
 * Attach (or replace) a source record for a run.
 * Throws if the run does not exist.
 * Uses INSERT OR REPLACE so callers can upsert without extra checks.
 */
export function attachSource(db: any, runId: string, source: RunSourceInput): RunSource {
  const run = db
    .query("SELECT run_id FROM runs_current WHERE run_id = ?")
    .get(runId) as { run_id: string } | null
  if (!run) throw new Error(`Run not found: ${runId}`)

  const now = new Date().toISOString()
  db.run(
    "INSERT OR REPLACE INTO run_sources_current (run_id, kind, title, content, source_path, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [runId, source.kind, source.title, source.content, source.source_path ?? null, now],
  )

  return {
    run_id: runId,
    kind: source.kind,
    title: source.title,
    content: source.content,
    source_path: source.source_path ?? null,
    created_at: now,
  }
}

/**
 * Retrieve the source record for a run.
 * Returns null if the run has no attached source (or the run doesn't exist).
 */
export function getSource(db: any, runId: string): RunSource | null {
  const row = db
    .query("SELECT * FROM run_sources_current WHERE run_id = ?")
    .get(runId) as RunSource | null
  return row ?? null
}
