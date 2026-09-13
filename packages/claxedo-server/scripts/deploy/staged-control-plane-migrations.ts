import fs from "node:fs"
import path from "node:path"

const serverRoot = path.resolve(import.meta.dirname, "../..")

/** `migrations_dir` for a config written beside its staged migrations. */
export const STAGED_CONTROL_PLANE_MIGRATIONS_DIR = "migrations/control-plane"

/**
 * Copy the control-plane migrations beside a rendered Wrangler config, and
 * answer with the `migrations_dir` that names them from the config file.
 *
 * `wrangler d1 migrations apply` reads whatever the config points at, so the
 * config names a copy this build wrote rather than the shared source
 * directory: a config and the migrations it applies cannot then disagree, and
 * no deploy can reach back into the tree every other reader shares.
 */
export function stageWorkerControlPlaneMigrations(input: {
  /** Directory the Wrangler config file itself is written to. */
  configDirectory: string
  /** Absolute directory to hold the staged copy; defaults to `migrations/` beside the config. */
  stageInto?: string
}): { migrationsDir: string } {
  const destination = path.join(input.stageInto ?? path.join(input.configDirectory, "migrations"), "control-plane")
  fs.cpSync(path.join(serverRoot, "migrations/control-plane"), destination, { recursive: true })
  return { migrationsDir: path.relative(input.configDirectory, destination).split(path.sep).join("/") }
}
