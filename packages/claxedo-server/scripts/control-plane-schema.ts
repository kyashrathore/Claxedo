import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"

export const CONTROL_PLANE_BASELINE = "0001_baseline.sql"
export const CONTROL_PLANE_MIGRATIONS_DIRECTORY = fileURLToPath(new URL("../migrations/control-plane/", import.meta.url))

/** The shipped baseline's SQL, refusing a migrations directory that holds anything else. */
export function currentControlPlaneBaseline(): string {
  const names = readdirSync(CONTROL_PLANE_MIGRATIONS_DIRECTORY).filter((name) => name.endsWith(".sql")).sort()
  if (names.join() !== CONTROL_PLANE_BASELINE) {
    throw new Error(`Control-plane migrations must be only ${CONTROL_PLANE_BASELINE}, found ${names.join(", ")}. Run bun run d1:baseline:generate.`)
  }
  return readFileSync(`${CONTROL_PLANE_MIGRATIONS_DIRECTORY}${CONTROL_PLANE_BASELINE}`, "utf8")
}

/** The baseline's CREATE statements; the generator guarantees no statement contains a semicolon followed by a blank line. */
export function baselineStatements(source: string): string[] {
  return source.split(/;\n\n/).map((part) => part.trim().replace(/;$/, "")).filter(Boolean)
}

const comparable = (sql: string) => sql.replace(/\s+/g, " ").trim()

/**
 * "empty" when the deploy may install the baseline, "baseline" when the
 * database already holds exactly the current one, and an error for anything
 * else: older migration history, an earlier baseline, or untracked tables.
 * Stored rows are never converted.
 */
export async function requireControlPlaneBaseline(
  rows: (sql: string) => Promise<readonly Record<string, unknown>[]>,
  baseline: string,
): Promise<"empty" | "baseline"> {
  const objects = await rows(`select name, sql from sqlite_master where sql is not null
    and substr(name, 1, 7) <> 'sqlite_' and substr(name, 1, 4) <> '_cf_'`)
  const tracked = objects.some((object) => object.name === "d1_migrations")
  const history = tracked ? (await rows("select name from d1_migrations order by id")).map((row) => row.name) : []
  const stored = objects.filter((object) => object.name !== "d1_migrations").map((object) => comparable(String(object.sql))).sort()
  if (!stored.length && !history.length) return "empty"
  const expected = baselineStatements(baseline).map(comparable).sort()
  if (history.join() === CONTROL_PLANE_BASELINE && stored.join("\n") === expected.join("\n")) return "baseline"
  throw new Error(`Control-plane D1 does not hold the current ${CONTROL_PLANE_BASELINE} (recorded migrations: ${history.join(", ") || "none"}). Its rows cannot be converted: delete it with \`wrangler d1 delete <database>\` and deploy again, which recreates it empty.`)
}
