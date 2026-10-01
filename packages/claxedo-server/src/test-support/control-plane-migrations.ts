import { Miniflare } from "miniflare"
import type { D1Database } from "@cloudflare/workers-types"
import {
  CONTROL_PLANE_BASELINE,
  baselineStatements,
  currentControlPlaneBaseline,
  requireBaselineFiles,
  requireControlPlaneBaseline,
} from "../../scripts/control-plane-schema"

export function controlPlaneMigrations(): readonly string[] {
  currentControlPlaneBaseline()
  return [CONTROL_PLANE_BASELINE]
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
  const baseline = currentControlPlaneBaseline()
  const state = await requireControlPlaneBaseline(async (sql) => (await database.prepare(sql).all()).results, baseline)
  if (state === "baseline") return
  const statements = baselineStatements(baseline).map((statement) => database.prepare(statement))
  await database.batch([
    database.prepare("create table if not exists d1_migrations (id integer primary key autoincrement, name text unique, applied_at timestamp default current_timestamp not null)"),
    ...statements,
    database.prepare(`insert into d1_migrations(name) values ('${CONTROL_PLANE_BASELINE}')`),
  ])
}
