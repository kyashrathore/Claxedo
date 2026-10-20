import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { TASKS_D1_SCHEMA_DIR } from "@claxedo/tasks/storage/d1/schema"

export const CONTROL_PLANE_BASELINE = "0001_baseline.sql"
export const CONTROL_PLANE_MIGRATIONS_DIRECTORY = fileURLToPath(new URL("../migrations/control-plane/", import.meta.url))

/** Every owner's baseline the deployed control-plane schema is rendered from: the host's tables, then each composed plugin's. */
export const CONTROL_PLANE_SCHEMA_SOURCES: readonly string[] = [CONTROL_PLANE_MIGRATIONS_DIRECTORY, TASKS_D1_SCHEMA_DIR]

/** One source's baseline SQL, refusing a source directory that holds any other SQL file. */
export function sourceControlPlaneBaseline(directory: string): string {
  const names = readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()
  if (names.join() !== CONTROL_PLANE_BASELINE) {
    throw new Error(`Control-plane migrations in ${directory} must be only ${CONTROL_PLANE_BASELINE}, found ${names.join(", ")}. Run bun run d1:baseline:generate.`)
  }
  return readFileSync(path.join(directory, CONTROL_PLANE_BASELINE), "utf8")
}

const TYPE_ORDER: Readonly<Record<string, number>> = { table: 0, view: 1, index: 2, trigger: 3 }
const OBJECT = /^CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX|TRIGGER|VIEW)\s+["`]?([A-Za-z0-9_]+)/i

/**
 * The one baseline a deploy applies: every source's statements in the order
 * the generator writes them (`sqlite_master` by type, then name), so the
 * deployed file is the same text one combined database would render.
 */
export function currentControlPlaneBaseline(): string {
  const objects = CONTROL_PLANE_SCHEMA_SOURCES.flatMap((source) => baselineStatements(sourceControlPlaneBaseline(source)).map((sql) => {
    const match = OBJECT.exec(sql)
    if (!match?.[1] || !match[2]) throw new Error(`${source}: cannot name the object this statement creates: ${sql.slice(0, 80)}`)
    return { order: TYPE_ORDER[match[1].toLowerCase()] ?? Number.MAX_SAFE_INTEGER, name: match[2], sql }
  }))
  const names = new Set<string>()
  for (const object of objects) {
    if (names.has(object.name)) throw new Error(`Control-plane object ${object.name} is created by two baselines`)
    names.add(object.name)
  }
  const ordered = objects.sort((left, right) => left.order - right.order || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  return ordered.map((object) => `${object.sql};`).join("\n\n") + "\n"
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
