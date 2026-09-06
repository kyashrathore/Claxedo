/**
 * The canonical-helper manifest (`canonical.json`), decoded once for both the
 * ratchet and the worklist so the two cannot disagree about its shape.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { readJsonFile } from "../../packages/claxedo-helpers/src/fs.ts"
import { isRecord, isString } from "../../packages/claxedo-helpers/src/guards.ts"

export const MANIFEST = path.join(import.meta.dirname, "canonical.json")

export type CanonicalManifest = {
  canonical: { module: string; owner: string; names: string[] }[]
  twins: { reason: string; files: string[] }[]
}

function stringList(value: unknown): string[] | undefined {
  const items: unknown[] | undefined = Array.isArray(value) ? value : undefined
  return items?.every(isString) ? items : undefined
}

function malformed(field: string): never {
  throw new Error(`${MANIFEST}: ${field} is malformed`)
}

/** A missing manifest reads as empty; a present but malformed one throws. */
export function readCanonicalManifest(): CanonicalManifest {
  if (!fs.existsSync(MANIFEST)) return { canonical: [], twins: [] }
  const raw = readJsonFile(MANIFEST)
  if (!isRecord(raw)) return malformed("document")
  const canonicalRows: unknown[] | undefined = Array.isArray(raw.canonical) ? raw.canonical : undefined
  const twinRows: unknown[] | undefined = Array.isArray(raw.twins) ? raw.twins : undefined
  if (!canonicalRows || !twinRows) return malformed("canonical/twins")
  return {
    canonical: canonicalRows.map((row) => {
      const names = isRecord(row) ? stringList(row.names) : undefined
      if (!isRecord(row) || !isString(row.module) || !isString(row.owner) || !names) return malformed("canonical entry")
      return { module: row.module, owner: row.owner, names }
    }),
    twins: twinRows.map((row) => {
      const files = isRecord(row) ? stringList(row.files) : undefined
      if (!isRecord(row) || !isString(row.reason) || !files) return malformed("twin entry")
      return { reason: row.reason, files }
    }),
  }
}
