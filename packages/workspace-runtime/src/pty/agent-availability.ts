/**
 * Which agent CLIs this machine can actually start.
 *
 * A wrapper is written into BIN_DIR for every shimmed agent whether or not the
 * real CLI is installed, and BIN_DIR is first on a terminal's PATH — so a
 * lookup that took the terminal's PATH at face value would report every agent
 * as present. The scan skips the wrapper directories for the same reason
 * `find_real_binary` does inside the wrappers themselves.
 */
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { BIN_DIR, listWrapperAgents } from "../agent-hooks"

const LEGACY_BIN_DIR = path.join(os.homedir(), ".workspace-runtime", "bin")

async function executable(file: string) {
  try {
    const stat = await fs.promises.stat(file)
    if (!stat.isFile()) return false
    await fs.promises.access(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function searchPath(value: string | undefined) {
  return (value ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .filter((dir) => path.resolve(dir) !== BIN_DIR && path.resolve(dir) !== LEGACY_BIN_DIR)
}

export async function installedAgents(
  names: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const dirs = searchPath(env.PATH)
  const found = await Promise.all(
    names.map(async (name) => {
      for (const dir of dirs) {
        if (await executable(path.join(dir, name))) return name
      }
      return undefined
    }),
  )
  return found.filter((name): name is string => name !== undefined)
}

/** Every agent this runtime wraps, reduced to the ones present on this machine. */
export async function installedWrapperAgents(env?: NodeJS.ProcessEnv) {
  const { all } = await listWrapperAgents()
  return installedAgents(all, env)
}
