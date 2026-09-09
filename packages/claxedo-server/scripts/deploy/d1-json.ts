import { asRecord, isRecordArray, parseJson } from "@claxedo/server-core/platform/json/index"

/**
 * The ONE reader for `wrangler d1 execute --json` output.
 *
 * `prove-greenfield-target-absence.ts`, `prepare-better-auth-d1.ts` and
 * `provision-user-deployed-owner-claim.ts` each wrote the same three checks —
 * one-element array, `success === true`, `results` is an array — and then
 * asserted the rows into `Array<Record<string, unknown>>`. They disagreed on
 * which of the three they actually enforced, so the same malformed output was a
 * clear error in one script and an empty pass in another.
 */
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
