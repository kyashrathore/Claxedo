import fs from "node:fs"
import path from "node:path"

/**
 * Staging a migration directory into a build artifact.
 *
 * A migration runner applies every migration it finds in the directory it is
 * pointed at, so a staged migration IS an applied migration: a build that
 * excludes a feature's code but copies its SQL still creates that feature's
 * tables. The whole directory is copied — these are generated outputs a build
 * must not curate — except the entries below, each owned by a build-selected
 * feature and each keyed to the same variable that selects it.
 *
 * Both tables name the same feature in the two schemas it owns:
 * `platform/db/db.ts` lists the SQLite journal at boot, and
 * `wrangler d1 migrations apply` lists the D1 directory a Worker config's
 * `migrations_dir` names.
 */
type OptionalMigration = { entry: string; enabled: (env: NodeJS.ProcessEnv) => boolean }

const tasksSelected = (env: NodeJS.ProcessEnv) => env.CLAXEDO_BUILD_TASKS !== "0"

const OPTIONAL_JOURNAL_MIGRATIONS: ReadonlyArray<OptionalMigration> = [
  { entry: "20260912100000_claxedo_tasks", enabled: tasksSelected },
]

const OPTIONAL_D1_CONTROL_PLANE_MIGRATIONS: ReadonlyArray<OptionalMigration> = [
  { entry: "0024_claxedo_tasks.sql", enabled: tasksSelected },
]

function stage(
  source: string,
  destination: string,
  optional: ReadonlyArray<OptionalMigration>,
  env: NodeJS.ProcessEnv,
): { excluded: string[] } {
  const root = path.resolve(source)
  const missing = optional.filter((item) => !fs.existsSync(path.join(root, item.entry)))
  if (missing.length > 0) {
    // A renamed or deleted migration would otherwise make the exclusion a
    // no-op, and the off artifact would ship the tables again with every gate
    // still green.
    throw new Error(
      `migration directory ${source} has no ${missing.map((item) => item.entry).join(", ")}; ` +
        "update script/migration-journal.ts",
    )
  }
  const excluded = optional.filter((item) => !item.enabled(env)).map((item) => item.entry)
  const skip = new Set(excluded.map((entry) => path.join(root, entry)))
  fs.cpSync(root, destination, { recursive: true, filter: (from) => !skip.has(path.resolve(from)) })
  return { excluded }
}

export function stageMigrationJournal(
  source: string,
  destination: string,
  env: NodeJS.ProcessEnv = process.env,
): { excluded: string[] } {
  return stage(source, destination, OPTIONAL_JOURNAL_MIGRATIONS, env)
}

export function stageD1ControlPlaneMigrations(
  source: string,
  destination: string,
  env: NodeJS.ProcessEnv = process.env,
): { excluded: string[] } {
  return stage(source, destination, OPTIONAL_D1_CONTROL_PLANE_MIGRATIONS, env)
}
