/**
 * A miniflare D1 database with named control-plane migrations applied.
 *
 * The real migration files run rather than a schema written next to the test:
 * a hand-written one proves the store works against a table that does not
 * ship.
 */
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { Miniflare } from "miniflare"
import type { D1Database } from "@cloudflare/workers-types"

/**
 * Statements are separated by a blank line, which is how the control-plane
 * migrations are written and the only separator D1's `prepare` can be handed
 * one at a time. A file that packs statements onto consecutive lines would
 * otherwise apply as one statement and silently drop the rest, so it is
 * refused here instead.
 */
function migrationStatements(source: string, name: string): string[] {
  const statements = source
    .replace(/^\s*--.*$/gm, "")
    .split(/;\s*\n\s*\n/)
    .map((part) => part.trim().replace(/;$/, "").trim())
    .filter(Boolean)
  for (const statement of statements) {
    if (statement.includes(";")) {
      throw new Error(`Migration ${name} packs several statements together; separate them with a blank line`)
    }
  }
  return statements
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
  const database = await instance.getD1Database("CONTROL_PLANE_DB")
  for (const name of migrations) await applyControlPlaneMigration(database, name)
  return { database, dispose: () => instance.dispose() }
}

export async function applyControlPlaneMigration(database: D1Database, name: string): Promise<void> {
  const path = fileURLToPath(new URL(`../../migrations/control-plane/${name}`, import.meta.url))
  for (const statement of migrationStatements(await readFile(path, "utf8"), name)) {
    await database.prepare(statement).run()
  }
}
