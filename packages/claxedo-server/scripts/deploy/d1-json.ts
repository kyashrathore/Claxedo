import { asRecord, isRecordArray, parseJson } from "@claxedo/server-core/platform/json/index"

/** The one reader for `wrangler d1 execute --json` output: one result set, `success`, and an array of rows. */
export function d1Rows(output: string, label: string): Record<string, unknown>[] {
  let parsed: unknown
  try {
    parsed = parseJson(output)
  } catch {
    throw new Error(`${label} did not return JSON`)
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error(`${label} returned no result set`)
  const result = asRecord(parsed[0])
  if (result?.success !== true || !isRecordArray(result.results)) throw new Error(`${label} query failed`)
  return result.results
}

/** The single row a verification query must have produced. */
export function d1Row(output: string, label: string): Record<string, unknown> {
  const rows = d1Rows(output, label)
  const row = rows[0]
  if (rows.length !== 1 || !row) throw new Error(`${label} did not return exactly one row`)
  return row
}
