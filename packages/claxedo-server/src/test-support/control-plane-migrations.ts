import { Miniflare } from "miniflare"
import type { D1Database } from "@cloudflare/workers-types"
import { baselineStatements, currentControlPlaneBaseline } from "../../scripts/control-plane-schema"
import { WORKERS_COMPATIBILITY_DATE } from "../../scripts/deploy/hosted-worker-bundle"

export type ControlPlaneDatabase = {
  database: D1Database
  dispose(): Promise<void>
}

export async function miniflareControlPlaneDatabase(): Promise<ControlPlaneDatabase> {
  const instance = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: WORKERS_COMPATIBILITY_DATE,
    d1Databases: ["CONTROL_PLANE_DB"],
  })
  try {
    const database = await instance.getD1Database("CONTROL_PLANE_DB")
    await applyControlPlaneBaseline(database)
    return { database, dispose: () => instance.dispose() }
  } catch (error) {
    await instance.dispose()
    throw error
  }
}

export async function applyControlPlaneBaseline(database: D1Database): Promise<void> {
  await database.batch(baselineStatements(currentControlPlaneBaseline()).map((statement) => database.prepare(statement)))
}
