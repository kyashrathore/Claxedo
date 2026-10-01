import { readdirSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { Miniflare } from "miniflare"
import type { D1Database } from "@cloudflare/workers-types"
import { CONTROL_PLANE_BASELINE, requireBaselineFiles, requireControlPlaneBaseline } from "../../scripts/control-plane-schema"

// Trigger bodies contain semicolons; schema objects are separated by blank lines.
function migrationChunks(source: string): string[] {
  return source
    .replace(/^\s*--.*$/gm, "")
    .split(/;\s*\n\s*\n/)
    .map((part) => part.trim().replace(/;$/, "").trim())
    .filter(Boolean)
}

const CONTROL_PLANE_MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL("../../migrations/control-plane/", import.meta.url),
)

export function controlPlaneMigrations(): readonly string[] {
  const names = readdirSync(CONTROL_PLANE_MIGRATIONS_DIRECTORY).filter((name) => name.endsWith(".sql")).sort()
  requireBaselineFiles(names)
  return names
}

function controlPlaneMigrationPath(name: string): string {
  return `${CONTROL_PLANE_MIGRATIONS_DIRECTORY}${name}`
}

export type ControlPlaneDatabase = {
  database: D1Database
  dispose(): Promise<void>
}

export async function miniflareControlPlaneDatabase(
  migrations: readonly string[],
): Promise<ControlPlaneDatabase> {
  requireBaselineFiles(migrations)
  const instance = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2025-05-01",
    d1Databases: ["CONTROL_PLANE_DB"],
  })
  try {
    const database = await instance.getD1Database("CONTROL_PLANE_DB")
    for (const name of migrations) await applyControlPlaneMigration(database, name)
    return { database, dispose: () => instance.dispose() }
  } catch (error) {
    await instance.dispose()
    throw error
  }
}

export async function applyControlPlaneMigration(database: D1Database, name: string): Promise<void> {
  requireBaselineFiles([name])
  const state = await requireControlPlaneBaseline(async (sql) => (await database.prepare(sql).all()).results)
  if (state === "baseline") return
  const path = controlPlaneMigrationPath(name)
  const statements = migrationChunks(await readFile(path, "utf8")).map((chunk) => database.prepare(chunk))
  await database.batch([
    database.prepare("create table if not exists d1_migrations (id integer primary key autoincrement, name text unique, applied_at timestamp default current_timestamp not null)"),
    ...statements,
    database.prepare(`insert into d1_migrations(name) values ('${CONTROL_PLANE_BASELINE}')`),
  ])
}
