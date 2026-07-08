import path from "path"
import os from "os"

export function dataDir(): string {
  return process.env.CLAXEDO_DATA_DIR ?? path.join(os.homedir(), ".claxedo")
}

export function stateDir(): string {
  return process.env.CLAXEDO_STATE_DIR ?? path.join(dataDir(), "state")
}
