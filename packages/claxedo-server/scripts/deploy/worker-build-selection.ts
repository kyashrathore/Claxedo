import path from "node:path"

import { stageD1ControlPlaneMigrations } from "../../../../script/migration-journal"

const serverRoot = path.resolve(import.meta.dirname, "../..")

/**
 * What a rendered Worker config must carry for a build-selected feature.
 *
 * A Worker artifact's feature selection has two halves and both are decided
 * here, when the config is rendered: the `[define]` esbuild folds, which is
 * what removes the feature's code from the uploaded bundle, and the
 * `migrations_dir` that `wrangler d1 migrations apply` lists, which is what
 * keeps the feature's tables out of the control-plane database. Baking the
 * selection is the point — a variable read inside the isolate would let the
 * deployed artifact serve a feature its migrations never created.
 */
export const WORKER_BUILD_SELECTION_DEFINES = ["process.env.CLAXEDO_BUILD_TASKS"] as const

/** `migrations_dir` for a config written beside its staged migrations. */
export const STAGED_CONTROL_PLANE_MIGRATIONS_DIR = "migrations/control-plane"

export function renderWorkerBuildSelectionDefine(env: NodeJS.ProcessEnv = process.env) {
  // Only an explicit "0" turns Tasks off: a deploy that never sets the
  // variable must ship the feature rather than silently drop it.
  const tasks = env.CLAXEDO_BUILD_TASKS === "0" ? "0" : "1"
  return `[define]
"process.env.CLAXEDO_BUILD_TASKS" = ${JSON.stringify(JSON.stringify(tasks))}
`
}

/**
 * Stage the control-plane migrations this build selects, and answer with the
 * `migrations_dir` that names them from beside the config file.
 *
 * The staged copy is what the config points at, so the rendered value and the
 * bytes on disk cannot disagree. The source directory is never curated: a
 * build that excluded a migration by deleting the file would also delete it
 * from every test and every other deployment that reads the same schema.
 */
export function stageWorkerControlPlaneMigrations(input: {
  /** Directory the Wrangler config file itself is written to. */
  configDirectory: string
  /** Absolute directory to hold the staged copy; defaults to `migrations/` beside the config. */
  stageInto?: string
  env?: NodeJS.ProcessEnv
}): { migrationsDir: string; excluded: string[] } {
  const destination = path.join(input.stageInto ?? path.join(input.configDirectory, "migrations"), "control-plane")
  const { excluded } = stageD1ControlPlaneMigrations(
    path.join(serverRoot, "migrations/control-plane"),
    destination,
    input.env ?? process.env,
  )
  return { migrationsDir: path.relative(input.configDirectory, destination).split(path.sep).join("/"), excluded }
}
