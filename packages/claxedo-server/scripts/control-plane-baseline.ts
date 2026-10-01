import { Database } from "bun:sqlite"
import { existsSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { CONTROL_PLANE_BASELINE, CONTROL_PLANE_MIGRATIONS_DIRECTORY, baselineStatements } from "./control-plane-schema"

type SchemaObject = { type: string; name: string; tbl_name: string; sql: string }

const OBJECT_TYPES = ["table", "view", "index", "trigger"]
const GENERATE_COMMAND = "bun run d1:baseline:generate"

function schemaObjects(database: Database) {
  return database.query<SchemaObject, []>(`select type, name, tbl_name, sql from sqlite_master
    where sql is not null and substr(name, 1, 7) <> 'sqlite_' order by type, name`).all()
}

function dumpSchema(database: Database) {
  const objects = schemaObjects(database)
  for (const object of objects) {
    if (!OBJECT_TYPES.includes(object.type) || /^CREATE\s+VIRTUAL\s+TABLE/i.test(object.sql)) {
      throw new Error(`${object.name}: the control-plane baseline cannot carry ${object.type} objects of this kind`)
    }
    // wrangler strips SQL comments before D1 runs a migration, so D1 would store different text than the baseline holds.
    if (/--|\/\*/.test(object.sql)) throw new Error(`${object.name}: remove the SQL comment from its CREATE statement`)
    if (object.sql.includes(";\n\n")) throw new Error(`${object.name}: a blank line after a semicolon would split the statement`)
  }
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
  for (const type of OBJECT_TYPES.slice(1)) ordered.push(...objects.filter((object) => object.type === type))
  return ordered.map((object) => `${object.sql};`).join("\n\n") + "\n"
}

function openDatabase() {
  const database = new Database(":memory:")
  database.exec("PRAGMA foreign_keys = ON")
  return database
}

/** The baseline the migrations in `directory` produce, verified to rebuild exactly the schema they built. */
export function renderControlPlaneBaseline(directory: string) {
  const names = readdirSync(directory).filter((name) => /^\d+_.+\.sql$/.test(name)).sort()
  if (!names.length) throw new Error(`No control-plane migrations in ${directory}`)
  const chain = openDatabase()
  const replay = openDatabase()
  try {
    for (const name of names) chain.transaction(() => chain.exec(readFileSync(path.join(directory, name), "utf8")))()
    const schema = dumpSchema(chain)
    replay.transaction(() => { for (const statement of baselineStatements(schema)) replay.exec(statement) })()
    if (JSON.stringify(schemaObjects(replay)) !== JSON.stringify(schemaObjects(chain))) {
      throw new Error("Control-plane baseline does not rebuild the schema its migrations built")
    }
    if (replay.query("PRAGMA foreign_key_check").all().length) throw new Error("Control-plane baseline has invalid foreign keys")
    return { schema, folded: names.filter((name) => name !== CONTROL_PLANE_BASELINE) }
  } finally {
    chain.close()
    replay.close()
  }
}

export function generateControlPlaneBaseline(directory: string) {
  const { schema, folded } = renderControlPlaneBaseline(directory)
  const destination = path.join(directory, CONTROL_PLANE_BASELINE)
  const temporary = `${destination}.tmp`
  writeFileSync(temporary, schema)
  renameSync(temporary, destination)
  for (const name of folded) unlinkSync(path.join(directory, name))
  return { folded, bytes: Buffer.byteLength(schema) }
}

/** Fails unless `directory` holds only the baseline and the baseline is byte-for-byte the generator's output. */
export function checkControlPlaneBaseline(directory: string) {
  const { schema, folded } = renderControlPlaneBaseline(directory)
  if (folded.length) throw new Error(`Migrations not folded into ${CONTROL_PLANE_BASELINE}: ${folded.join(", ")}. Run ${GENERATE_COMMAND}.`)
  const destination = path.join(directory, CONTROL_PLANE_BASELINE)
  if (!existsSync(destination) || readFileSync(destination, "utf8") !== schema) {
    throw new Error(`${CONTROL_PLANE_BASELINE} is not the generator's output. Run ${GENERATE_COMMAND}.`)
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const check = args[0] === "--check"
  const rest = check ? args.slice(1) : args
  if (rest.length && (rest.length !== 2 || rest[0] !== "--directory" || !rest[1])) {
    throw new Error("Usage: bun run scripts/control-plane-baseline.ts [--check] [--directory <migrations directory>]")
  }
  const directory = path.resolve(rest[1] ?? CONTROL_PLANE_MIGRATIONS_DIRECTORY)
  if (check) {
    checkControlPlaneBaseline(directory)
    console.log(`${CONTROL_PLANE_BASELINE} is current`)
  } else {
    const result = generateControlPlaneBaseline(directory)
    console.log(`${CONTROL_PLANE_BASELINE}: ${result.bytes} bytes; folded ${result.folded.length} migrations${result.folded.length ? `: ${result.folded.join(", ")}` : ""}`)
  }
}
