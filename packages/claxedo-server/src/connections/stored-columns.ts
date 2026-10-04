/**
 * The two JSON columns a connection row carries, decoded. `JSON.parse` is
 * `any`, so both used to be asserted straight into their element types — a
 * stored `null`, or a capability list holding a number, reached the connections
 * kit typed as valid.
 *
 * Both storage backends persist the same two columns: the SQLite adapter in
 * `store-adapter.ts` and the hosted D1 store in `hosted-d1/`. This file owns the
 * decoding for both. It deliberately holds no schema import — the D1 worker
 * must not reach `connection.sql`, whose Drizzle table is SQLite-only.
 */
import type { IntegrationCapability } from "@claxedo/connections"
import { asRecord, parseJson } from "@claxedo/server-core/platform/json/index"

export function storedCapabilities(raw: string): IntegrationCapability[] {
  const parsed = parseJson(raw)
  return Array.isArray(parsed) ? parsed.filter((value): value is IntegrationCapability => typeof value === "string") : []
}

export function storedFields(raw: string): Record<string, string> {
  const parsed = asRecord(parseJson(raw))
  if (!parsed) return {}
  return Object.fromEntries(
    Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
}
