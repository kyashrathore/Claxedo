import { Database } from "bun:sqlite"
import { readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { CONTROL_PLANE_BASELINE } from "./control-plane-schema"

type SchemaObject = { type: string; name: string; tbl_name: string; sql: string }

function normalizedSql(sql: string) {
  return sql.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trimEnd()).join("\n").trim().replace(/;$/, "") + ";"
}

function dumpSchema(database: Database) {
  const objects = database.query<SchemaObject, []>(`select type, name, tbl_name, sql from sqlite_master
    where sql is not null and substr(name, 1, 7) <> 'sqlite_'
      and type in ('table', 'index', 'trigger') order by type, name`).all()
  const tables = new Map(objects.filter((object) => object.type === "table").map((object) => [object.name, object]))
  const ordered: SchemaObject[] = []
  const visiting = new Set<string>()
  const visited = new Set<string>()
  function visit(name: string) {
    if (visited.has(name) || visiting.has(name)) return
    visiting.add(name)
    const dependencies = database.query<{ table: string }, []>(`pragma foreign_key_list("${name.replaceAll('"', '""')}")`).all()
    for (const dependency of [...new Set(dependencies.map((row) => row.table))].sort()) {
      if (tables.has(dependency)) visit(dependency)
    }
    visiting.delete(name)
    visited.add(name)
    ordered.push(tables.get(name)!)
  }
  for (const name of [...tables.keys()].sort()) visit(name)
  ordered.push(...objects.filter((object) => object.type === "index"), ...objects.filter((object) => object.type === "trigger"))
  return ordered.map((object) => normalizedSql(object.sql)).join("\n\n") + "\n"
}

export function generateControlPlaneBaseline(directory: string) {
  const names = readdirSync(directory).filter((name) => /^\d+_.+\.sql$/.test(name)).sort()
  if (!names.length) throw new Error(`No control-plane migrations in ${directory}`)
  const database = new Database(":memory:")
  let schema: string
  try {
    database.exec("PRAGMA foreign_keys = ON")
    for (const name of names) database.transaction(() => database.exec(readFileSync(path.join(directory, name), "utf8")))()
    schema = dumpSchema(database)
  } finally {
    database.close()
  }
  const verification = new Database(":memory:")
  try {
    verification.exec("PRAGMA foreign_keys = ON")
    verification.transaction(() => verification.exec(schema))()
    if (dumpSchema(verification) !== schema) throw new Error("Control-plane baseline does not reproduce its schema")
    if (verification.query("PRAGMA foreign_key_check").all().length) throw new Error("Control-plane baseline has invalid foreign keys")
  } finally {
    verification.close()
  }
  const destination = path.join(directory, CONTROL_PLANE_BASELINE)
  const temporary = `${destination}.tmp`
  writeFileSync(temporary, schema)
  renameSync(temporary, destination)
  for (const name of names) if (name !== CONTROL_PLANE_BASELINE) unlinkSync(path.join(directory, name))
  return { replaced: names.filter((name) => name !== CONTROL_PLANE_BASELINE).length, bytes: Buffer.byteLength(schema) }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args.length && (args.length !== 2 || args[0] !== "--directory" || !args[1])) {
    throw new Error("Usage: bun run scripts/control-plane-baseline.ts [--directory <migrations directory>]")
  }
  const directory = path.resolve(args[1] ?? path.join(import.meta.dirname, "../migrations/control-plane"))
  const result = generateControlPlaneBaseline(directory)
  console.log(`${CONTROL_PLANE_BASELINE}: ${result.bytes} bytes; replaced ${result.replaced} migrations`)
}
