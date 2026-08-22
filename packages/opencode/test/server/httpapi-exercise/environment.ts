import { Flag } from "@opencode-ai/core/flag/flag"
import { Effect } from "effect"
import path from "path"
import {
  exerciseDatabasePath,
  exerciseGlobalRoot,
  preserveExerciseDatabase,
  preserveExerciseGlobalRoot,
} from "./environment-bootstrap"

export { exerciseDatabasePath, exerciseGlobalRoot }
export const exerciseConfigDirectory = path.join(exerciseGlobalRoot, "config", "opencode")
export const exerciseDataDirectory = path.join(exerciseGlobalRoot, "data", "opencode")

Flag.OPENCODE_DB = exerciseDatabasePath

export const original = {
  OPENCODE_SERVER_PASSWORD: Flag.OPENCODE_SERVER_PASSWORD,
  OPENCODE_SERVER_USERNAME: Flag.OPENCODE_SERVER_USERNAME,
}

export const cleanupExercisePaths = Effect.promise(async () => {
  const fs = await import("fs/promises")
  if (!preserveExerciseDatabase) {
    await Promise.all(
      [exerciseDatabasePath, `${exerciseDatabasePath}-wal`, `${exerciseDatabasePath}-shm`].map((file) =>
        fs.rm(file, { force: true }).catch(() => undefined),
      ),
    )
  }
  if (!preserveExerciseGlobalRoot)
    await fs.rm(exerciseGlobalRoot, { recursive: true, force: true }).catch(() => undefined)
})
