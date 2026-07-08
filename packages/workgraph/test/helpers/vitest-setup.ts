/**
 * Patches better-sqlite3 Database prototype with bun:sqlite-compatible
 * `query()`, `run()`, and `raw()` methods so existing test code works unchanged.
 *
 * `raw()` is needed so the source code's sqlite() compat layer (src/sqlite.ts)
 * can extract the native better-sqlite3 client from the patched object.
 */
import Database from "better-sqlite3"

const proto = Database.prototype as any

// bun:sqlite Database.query(sql) → better-sqlite3 Database.prepare(sql)
proto.query = proto.prepare

// bun:sqlite Database.run(sql, params?) → better-sqlite3 doesn't have this
const origRun = proto.run
proto.run = function (sql: string, params?: any[]) {
  if (params && params.length) return this.prepare(sql).run(...params)
  return this.exec(sql)
}

// Expose raw() so src/sqlite.ts client() can extract the native Database
proto.raw = function () {
  return this
}

// Provide filename compat (bun:sqlite uses .filename, better-sqlite3 uses .name)
if (!("filename" in proto)) {
  Object.defineProperty(proto, "filename", {
    get() { return this.name },
  })
}
