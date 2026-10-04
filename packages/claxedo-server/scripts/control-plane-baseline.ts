import { Database } from "bun:sqlite"
import { readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { CONTROL_PLANE_BASELINE, CONTROL_PLANE_MIGRATIONS_DIRECTORY, baselineStatements } from "./control-plane-schema"

type SchemaObject = { type: string; name: string; tbl_name: string; sql: string }

const TYPE_ORDER: Record<string, number> = { table: 0, view: 1, index: 2, trigger: 3 }
const GENERATE_COMMAND = "bun run d1:baseline:generate"

function schemaObjects(database: Database) {
  return database.query<SchemaObject, []>(`select type, name, tbl_name, sql from sqlite_master
    where sql is not null and substr(name, 1, 7) <> 'sqlite_' order by type, name`).all()
}

function openDatabase() {
  const database = new Database(":memory:")
  database.exec("PRAGMA foreign_keys = ON")
  return database
}

/** The baseline the migrations in `directory` produce, verified to rebuild exactly the schema they built. */
function renderControlPlaneBaseline(directory: string) {
  const names = readdirSync(directory).filter((name) => /^\d+_.+\.sql$/.test(name)).sort()
  const chain = openDatabase()
  const replay = openDatabase()
  try {
    for (const name of names) chain.transaction(() => chain.exec(readFileSync(path.join(directory, name), "utf8")))()
    const objects = schemaObjects(chain)
    for (const object of objects) {
      // wrangler strips SQL comments before D1 runs a migration, so D1 would store different text than the baseline holds.
      if (/--|\/\*/.test(object.sql)) throw new Error(`${object.name}: remove the SQL comment from its CREATE statement`)
      if (object.sql.includes(";\n\n")) throw new Error(`${object.name}: a blank line after a semicolon would split the statement`)
    }
    // SQLite resolves foreign keys when rows are written, so tables need no dependency order.
    const ordered = objects.sort((left, right) => TYPE_ORDER[left.type] - TYPE_ORDER[right.type])
    const schema = ordered.map((object) => `${object.sql};`).join("\n\n") + "\n"
    replay.transaction(() => { for (const statement of baselineStatements(schema)) replay.exec(statement) })()
    if (JSON.stringify(schemaObjects(replay)) !== JSON.stringify(schemaObjects(chain))) {
      throw new Error("Control-plane baseline does not rebuild the schema its migrations built")
    }
    return { schema, folded: names.filter((name) => name !== CONTROL_PLANE_BASELINE) }
  } finally {
    chain.close()
    replay.close()
  }
}

if (import.meta.main) {
  const check = process.argv[2] === "--check"
  const directory = path.resolve(process.argv[check ? 3 : 2] ?? CONTROL_PLANE_MIGRATIONS_DIRECTORY)
  const baseline = path.join(directory, CONTROL_PLANE_BASELINE)
  const { schema, folded } = renderControlPlaneBaseline(directory)
  if (check) {
    if (folded.length) throw new Error(`Migrations not folded into ${CONTROL_PLANE_BASELINE}: ${folded.join(", ")}. Run ${GENERATE_COMMAND}.`)
    if (readFileSync(baseline, "utf8") !== schema) throw new Error(`${CONTROL_PLANE_BASELINE} is not the generator's output. Run ${GENERATE_COMMAND}.`)
    console.log(`${CONTROL_PLANE_BASELINE} is current`)
  } else {
    writeFileSync(baseline, schema)
    for (const name of folded) unlinkSync(path.join(directory, name))
    console.log(`${CONTROL_PLANE_BASELINE}: folded ${folded.length} migrations${folded.length ? `: ${folded.join(", ")}` : ""}`)
  }
}
