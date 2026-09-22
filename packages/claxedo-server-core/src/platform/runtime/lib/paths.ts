import path from "path"
import os from "os"
import { envText } from "@claxedo/helpers"
import { absoluteConfiguredDir } from "@claxedo/helpers/path"

export function dataDir(): string {
  const configured = envText(process.env, "CLAXEDO_DATA_DIR")
  if (configured === undefined) return path.join(os.homedir(), ".claxedo")
  // `ClaxedoDB.Path` forwards this sentinel to sqlite instead of joining a
  // file onto it, so it reaches here as a directory that has no path shape.
  if (configured === ":memory:") return configured
  return absoluteConfiguredDir("CLAXEDO_DATA_DIR", configured)
}

export function stateDir(): string {
  const configured = envText(process.env, "CLAXEDO_STATE_DIR")
  if (configured === undefined) return path.join(dataDir(), "state")
  return absoluteConfiguredDir("CLAXEDO_STATE_DIR", configured)
}
