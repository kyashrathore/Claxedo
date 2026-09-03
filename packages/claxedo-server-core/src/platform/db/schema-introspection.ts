/**
 * One owner for "what does this SQLite file actually contain?".
 *
 * Schema repair and the authority store both open databases whose shape is not
 * known ahead of time, and both used to answer that question with their own
 * inline `PRAGMA table_info(...)` scan. Two copies of the same read is two
 * places to get identifier quoting wrong, so the reads live here instead.
 *
 * Identifiers are backtick-quoted: `PRAGMA table_info` takes a name, not a
 * bound parameter, so a table whose name needs quoting must still resolve.
 *
 * Deliberately typed against a minimal `prepare`/`all` surface rather than a
 * concrete driver, so a caller holding a `better-sqlite3` handle and a caller
 * holding the repair pass's structural handle can both use it.
 */

export type SqliteSchemaReader = {
  prepare(sql: string): {
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
  }
}

/** A row of `PRAGMA table_info`, narrowed to the fields callers read. */
export type SqliteColumnInfo = {
  name: string
  notnull?: number
}

export function hasTable(db: SqliteSchemaReader, table: string) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
}

/** `PRAGMA table_info` for `table`; empty when the table does not exist. */
export function tableColumns(db: SqliteSchemaReader, table: string) {
  return db.prepare(`PRAGMA table_info(\`${table}\`)`).all() as SqliteColumnInfo[]
}

export function columnInfo(db: SqliteSchemaReader, table: string, column: string) {
  return tableColumns(db, table).find((row) => row.name === column)
}

export function hasColumn(db: SqliteSchemaReader, table: string, column: string) {
  return tableColumns(db, table).some((row) => row.name === column)
}
