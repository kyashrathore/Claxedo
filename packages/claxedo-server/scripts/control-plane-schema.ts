import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"

export const CONTROL_PLANE_BASELINE = "0001_baseline.sql"
export const CONTROL_PLANE_RESET_COMMAND = "bun run d1:reset:staging"

const SCHEMA_OBJECTS_SQL = `select type, name, sql from sqlite_master
where type in ('table', 'view', 'index', 'trigger')
  and substr(name, 1, 7) <> 'sqlite_' and substr(name, 1, 4) <> '_cf_'
order by type, name`

/** The baseline's CREATE statements; the generator guarantees no statement contains a semicolon followed by a blank line. */
export function baselineStatements(source: string): string[] {
  return source.split(/;\n\n/).map((part) => part.trim().replace(/;$/, "")).filter(Boolean)
}

function comparable(sql: string) {
  return sql.replace(/\s+/g, " ").trim()
}

export async function requireControlPlaneBaseline(
  rows: (sql: string) => Promise<readonly Record<string, unknown>[]>,
  baseline: string,
): Promise<"empty" | "baseline"> {
  const all = await rows(SCHEMA_OBJECTS_SQL)
  const objects = all.filter((object) => object.name !== "d1_migrations")
  const history = objects.length === all.length ? [] : await rows("select name from d1_migrations order by id")
  const incompatible = history.filter((row) => row.name !== CONTROL_PLANE_BASELINE)
  if (incompatible.length) {
    throw new Error(`Control-plane D1 has pre-baseline migrations: ${incompatible.map((row) => row.name).join(", ")}. Reset staging with ${CONTROL_PLANE_RESET_COMMAND}; stored rows cannot be migrated.`)
  }
  if (!history.length) {
    if (objects.length) {
      throw new Error(`Control-plane D1 has an untracked schema. Reset staging with ${CONTROL_PLANE_RESET_COMMAND}; the baseline requires an empty database.`)
    }
    return "empty"
  }
  const stored = objects.flatMap((object) => typeof object.sql === "string" ? [comparable(object.sql)] : []).sort()
  const expected = baselineStatements(baseline).map(comparable).sort()
  if (JSON.stringify(stored) !== JSON.stringify(expected)) {
    throw new Error(`Control-plane D1 holds a different schema than the current ${CONTROL_PLANE_BASELINE}, which was regenerated after it was applied. Reset staging with ${CONTROL_PLANE_RESET_COMMAND}.`)
  }
  return "baseline"
}

export const CONTROL_PLANE_MIGRATIONS_DIRECTORY = fileURLToPath(new URL("../migrations/control-plane/", import.meta.url))

export function requireBaselineFiles(names: readonly string[]) {
  if (names.length !== 1 || names[0] !== CONTROL_PLANE_BASELINE) {
    throw new Error(`Control-plane migrations must be only ${CONTROL_PLANE_BASELINE}, found ${names.join(", ") || "none"}. Run bun run d1:baseline:generate.`)
  }
}

/** The shipped baseline's SQL, refusing a migrations directory that holds anything else. */
export function currentControlPlaneBaseline(): string {
  requireBaselineFiles(readdirSync(CONTROL_PLANE_MIGRATIONS_DIRECTORY).filter((name) => name.endsWith(".sql")).sort())
  return readFileSync(`${CONTROL_PLANE_MIGRATIONS_DIRECTORY}${CONTROL_PLANE_BASELINE}`, "utf8")
}
