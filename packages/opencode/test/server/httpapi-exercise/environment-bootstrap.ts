import path from "node:path"

// This module must run before importing any OpenCode source. Global path and
// flag modules cache environment-derived values at evaluation time.
export const preserveExerciseGlobalRoot = !!process.env.OPENCODE_HTTPAPI_EXERCISE_GLOBAL
export const exerciseGlobalRoot =
  process.env.OPENCODE_HTTPAPI_EXERCISE_GLOBAL ??
  path.join(process.env.TMPDIR ?? "/tmp", `opencode-httpapi-global-${process.pid}`)

process.env.XDG_DATA_HOME = path.join(exerciseGlobalRoot, "data")
process.env.XDG_CONFIG_HOME = path.join(exerciseGlobalRoot, "config")
process.env.XDG_STATE_HOME = path.join(exerciseGlobalRoot, "state")
process.env.XDG_CACHE_HOME = path.join(exerciseGlobalRoot, "cache")
process.env.OPENCODE_DISABLE_SHARE = "true"

export const preserveExerciseDatabase = !!process.env.OPENCODE_HTTPAPI_EXERCISE_DB
export const exerciseDatabasePath =
  process.env.OPENCODE_HTTPAPI_EXERCISE_DB ??
  path.join(process.env.TMPDIR ?? "/tmp", `opencode-httpapi-exercise-${process.pid}.db`)
process.env.OPENCODE_DB = exerciseDatabasePath
