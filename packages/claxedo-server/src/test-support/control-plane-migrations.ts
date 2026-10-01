import { Miniflare } from "miniflare"
import type { D1Database } from "@cloudflare/workers-types"
import { CONTROL_PLANE_BASELINE, baselineStatements, currentControlPlaneBaseline } from "../../scripts/control-plane-schema"

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
  if (name !== CONTROL_PLANE_BASELINE) throw new Error(`${name} is not ${CONTROL_PLANE_BASELINE}`)
  await database.batch(baselineStatements(currentControlPlaneBaseline()).map((statement) => database.prepare(statement)))
}
