/**
 * A miniflare D1 database with named control-plane migrations applied.
 *
 * The real migration files run rather than a schema written next to the test:
 * a hand-written one proves the store works against a table that does not
 * ship.
 */
import { readdirSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { Miniflare } from "miniflare"
import type { D1Database } from "@cloudflare/workers-types"

/**
 * A blank line after `;` is how the control-plane migrations separate most of
 * their statements, but not all of them: a trigger body carries its own `;`
 * terminators, and `0004` and `0014` put several `alter table` statements on
 * consecutive lines. Miniflare's D1 `prepare` runs every statement in the text
 * it is handed, so a chunk that holds more than one still applies whole.
 */
function migrationChunks(source: string): string[] {
  return source
    .replace(/^\s*--.*$/gm, "")
    .split(/;\s*\n\s*\n/)
    .map((part) => part.trim().replace(/;$/, "").trim())
    .filter(Boolean)
}

export const CONTROL_PLANE_MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL("../../migrations/control-plane/", import.meta.url),
)

/**
 * Every shipped control-plane migration, in the order a deployment applies
 * them.
 *
 * Read from the directory rather than listed at the call site: a curated
 * subset builds a schema no deployment ever runs, and a migration added and
 * not listed is simply never applied, which stays green.
 */
export function controlPlaneMigrations(): readonly string[] {
  return readdirSync(CONTROL_PLANE_MIGRATIONS_DIRECTORY).filter((name) => name.endsWith(".sql")).sort()
}

export function controlPlaneMigrationPath(name: string): string {
  return `${CONTROL_PLANE_MIGRATIONS_DIRECTORY}${name}`
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
  const path = controlPlaneMigrationPath(name)
  for (const chunk of migrationChunks(await readFile(path, "utf8"))) {
    await database.prepare(chunk).run()
  }
}
