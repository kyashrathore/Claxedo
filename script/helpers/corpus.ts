/**
 * The frozen Phase-1 helper corpus (`.artifacts/helpers/corpus.json`), decoded
 * once for the catalog and the worklist. Its numeric columns arrive as either
 * numbers or their decimal strings, so both spellings are accepted.
 */
import { readJsonFile } from "../../packages/claxedo-helpers/src/fs.ts"
import { isRecord, isString } from "../../packages/claxedo-helpers/src/guards.ts"

export type CorpusRow = {
  id: number
  pkg: string
  file: string
  line: number
  name: string
  hash: string
  loc: number
  movability: string
}

function numeric(value: unknown): number | undefined {
  if (typeof value === "number") return value
  return typeof value === "string" ? Number(value) : undefined
}

export function readCorpus(file: string): CorpusRow[] {
  const raw = readJsonFile(file)
  const rows: unknown[] | undefined = Array.isArray(raw) ? raw : undefined
  if (!rows) throw new Error(`${file}: not a corpus array`)
  return rows.map((row, index) => {
    const id = isRecord(row) ? numeric(row.id) : undefined
    const line = isRecord(row) ? numeric(row.line) : undefined
    const loc = isRecord(row) ? numeric(row.loc) : undefined
    if (
      !isRecord(row) ||
      id === undefined ||
      line === undefined ||
      loc === undefined ||
      !isString(row.pkg) ||
      !isString(row.file) ||
      !isString(row.name) ||
      !isString(row.hash) ||
      !isString(row.movability)
    ) {
      throw new Error(`${file}: row ${index} is not a corpus helper`)
    }
    return { id, pkg: row.pkg, file: row.file, line, name: row.name, hash: row.hash, loc, movability: row.movability }
  })
}
