import { asRecord, isRecordArray, readJsonRecord } from "@claxedo/server-core/platform/json/index"
import type { HostedCredentialDatabase, HostedCredentialStatement } from "../../src/credentials/worker/index"

/**
 * A control-plane D1 database reached through Cloudflare's HTTP API
 * (`POST /accounts/:account/d1/database/:database/query`), for an operator
 * process that holds the KEK but has no Worker binding. Each statement is one
 * request; the API answers with one result set per statement, carrying the
 * rows in `results` and the write count in `meta.changes`.
 */
export function d1HttpDatabase(input: {
  accountId: string
  databaseId: string
  apiToken: string
  fetchImpl?: typeof fetch
}): HostedCredentialDatabase {
  const url =
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(input.accountId)}` +
    `/d1/database/${encodeURIComponent(input.databaseId)}/query`
  const request = input.fetchImpl ?? fetch

  const query = async (sql: string, params: unknown[]) => {
    const response = await request(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${input.apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sql, params }),
      signal: AbortSignal.timeout(30_000),
    })
    const body = await readJsonRecord(response)
    const result = isRecordArray(body?.result) ? body.result[0] : undefined
    if (!response.ok || body?.success !== true || result?.success !== true || !isRecordArray(result.results)) {
      const errors = Array.isArray(body?.errors) ? JSON.stringify(body.errors) : ""
      throw new Error(`D1 query failed: HTTP ${response.status} ${errors}`.trim())
    }
    const changes = asRecord(result.meta)?.changes
    return { results: result.results, changes: typeof changes === "number" ? changes : undefined }
  }

  const statement = (sql: string, params: unknown[]): HostedCredentialStatement => ({
    bind: (...values) => statement(sql, values),
    first: async () => (await query(sql, params)).results[0] ?? null,
    all: async () => ({ results: (await query(sql, params)).results }),
    run: async () => ({ meta: { changes: (await query(sql, params)).changes } }),
  })

  return { prepare: (sql) => statement(sql, []) }
}
