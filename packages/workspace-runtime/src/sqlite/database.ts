/** What every driver reports from a write statement: the rows it changed. */
export type SqliteRunResult = {
  changes: number
}

/**
 * A prepared statement over rows of a single declared shape.
 *
 * `Row` is the column list the SQL selects, declared once at
 * `db.prepare<Row>(sql)` instead of re-asserted at every read. `get` widens to
 * `null | undefined` because the drivers disagree on the empty result.
 */
export type SqliteStatement<Row> = {
  run(...params: unknown[]): SqliteRunResult
  get(...params: unknown[]): Row | null | undefined
  all(...params: unknown[]): Row[]
}

/**
 * The synchronous SQLite surface the session store needs from its host.
 *
 * `transaction` is the only way to group writes: a Durable Object refuses
 * `BEGIN`/`COMMIT`/`ROLLBACK` text and requires `transactionSync`, and the Node
 * drivers take their write lock up front so two connections on one file
 * serialize instead of failing to upgrade a read lock.
 */
export type SqliteDatabase = {
  exec(sql: string): void
  prepare<Row = unknown>(sql: string): SqliteStatement<Row>
  transaction<T>(run: () => T): T
  close(): void
}
