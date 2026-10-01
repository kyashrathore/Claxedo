export const CONTROL_PLANE_BASELINE = "0001_baseline.sql"
export const CONTROL_PLANE_RESET_COMMAND = "bun run d1:reset:staging"

export const CONTROL_PLANE_SCHEMA_OBJECTS_SQL = `select type, name from sqlite_master
where type in ('table', 'view', 'index', 'trigger')
  and substr(name, 1, 7) <> 'sqlite_' and substr(name, 1, 4) <> '_cf_'
order by type, name`

export async function requireControlPlaneBaseline(
  rows: (sql: string) => Promise<readonly Record<string, unknown>[]>,
): Promise<"empty" | "baseline"> {
  const objects = await rows(CONTROL_PLANE_SCHEMA_OBJECTS_SQL)
  const tracked = objects.some((object) => object.type === "table" && object.name === "d1_migrations")
  const history = tracked ? await rows("select name from d1_migrations order by name") : []
  const incompatible = history.filter((row) => row.name !== CONTROL_PLANE_BASELINE)
  if (incompatible.length) {
    throw new Error(`Control-plane D1 has pre-baseline migrations: ${incompatible.map((row) => row.name).join(", ")}. Reset staging with ${CONTROL_PLANE_RESET_COMMAND}; stored rows cannot be migrated.`)
  }
  if (history.length === 1) return "baseline"
  if (history.length > 1 || objects.some((object) => object.name !== "d1_migrations")) {
    throw new Error(`Control-plane D1 has an untracked or incompatible schema. Reset staging with ${CONTROL_PLANE_RESET_COMMAND}; the baseline requires an empty database.`)
  }
  return "empty"
}

export function requireBaselineFiles(names: readonly string[]) {
  if (names.length !== 1 || names[0] !== CONTROL_PLANE_BASELINE) {
    throw new Error("Control-plane deploy requires only 0001_baseline.sql. Run bun run d1:baseline:generate before deploying.")
  }
}
