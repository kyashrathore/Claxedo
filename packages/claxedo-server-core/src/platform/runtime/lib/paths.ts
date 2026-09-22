import { claxedoDataDir, claxedoStateDir } from "@claxedo/helpers/path"

export function dataDir(): string {
  return claxedoDataDir()
}

export function stateDir(): string {
  return claxedoStateDir()
}

