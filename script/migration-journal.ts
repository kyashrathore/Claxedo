import fs from "node:fs"
import path from "node:path"

/**
 * Staging the SQLite migration journal into a server artifact.
 *
 * `platform/db/db.ts` lists this directory at boot and applies every migration
 * it finds, so a staged migration IS an applied migration: a build that
 * excludes a feature's code but copies its SQL still creates that feature's
 * tables in every profile the artifact opens.
 *
 * The whole directory is copied — the journal is generated output whose
 * contents the build must not curate — except the migrations below, each owned
 * by a build-selected feature and each keyed to the same variable that selects
 * it.
 */
const OPTIONAL_MIGRATIONS: ReadonlyArray<{ directory: string; enabled: (env: NodeJS.ProcessEnv) => boolean }> = [
  { directory: "20260912100000_claxedo_tasks", enabled: (env) => env.CLAXEDO_BUILD_TASKS !== "0" },
]

export function stageMigrationJournal(
  source: string,
  destination: string,
  env: NodeJS.ProcessEnv = process.env,
): { excluded: string[] } {
  const root = path.resolve(source)
  const missing = OPTIONAL_MIGRATIONS.filter((entry) => !fs.existsSync(path.join(root, entry.directory)))
  if (missing.length > 0) {
    // A renamed or deleted migration would otherwise make the exclusion a
    // no-op, and the off artifact would ship the tables again with every gate
    // still green.
    throw new Error(
      `migration journal ${source} has no ${missing.map((entry) => entry.directory).join(", ")}; ` +
        "update OPTIONAL_MIGRATIONS in script/migration-journal.ts",
    )
  }
  const excluded = OPTIONAL_MIGRATIONS.filter((entry) => !entry.enabled(env)).map((entry) => entry.directory)
  const skip = new Set(excluded.map((directory) => path.join(root, directory)))
  fs.cpSync(root, destination, { recursive: true, filter: (from) => !skip.has(path.resolve(from)) })
  return { excluded }
}
