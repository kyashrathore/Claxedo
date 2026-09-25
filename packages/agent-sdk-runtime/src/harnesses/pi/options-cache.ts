import fs from "node:fs/promises"
import path from "node:path"
import type { SdkModelEntry } from "../../sdk-model-options"

export type PiOptionsProbe = {
  readonly models: SdkModelEntry[]
  readonly thinking: string[]
  readonly selectedThinking: string
}

type Entry = { signature?: string; probe: Promise<PiOptionsProbe> }

const ENTRY_LIMIT = 32
const PROJECT_DIR = ".pi"

function stamp(file: string) {
  return fs.stat(file).then((stat) => `${stat.mtimeMs}:${stat.size}`, () => "absent")
}

async function projectDirs(directory: string) {
  const found: string[] = []
  for (let current = path.resolve(directory); ; current = path.dirname(current)) {
    const candidate = path.join(current, PROJECT_DIR)
    if (await fs.stat(candidate).then((stat) => stat.isDirectory(), () => false)) found.push(candidate)
    if (path.dirname(current) === current) return found
  }
}

/**
 * Pi's model answer is a function of its binary, the daemon's environment, the
 * provider projection `applyConfig` writes, the profile files it reads at start
 * (`settings.json`, `auth.json`, `models.json`), the `.pi` folders on the
 * workspace's path (project settings and extensions), and the model it is
 * asked about. The binary and the environment are fixed for the driver's life
 * and `clear` covers the projection, so answers are shared by workspaces that
 * see the same `.pi` folders and kept only while those files are the ones they
 * were read from.
 */
export function createPiOptionsCache(agentDir: string) {
  const entries = new Map<string, Entry>()

  async function signature(scope: readonly string[]) {
    const files = [
      path.join(agentDir, "settings.json"),
      path.join(agentDir, "auth.json"),
      path.join(agentDir, "models.json"),
      ...scope.flatMap((dir) => [dir, path.join(dir, "settings.json")]),
    ]
    return (await Promise.all(files.map(stamp))).join("|")
  }

  function remember(key: string, entry: Entry) {
    entries.delete(key)
    entries.set(key, entry)
    if (entries.size <= ENTRY_LIMIT) return
    const oldest = entries.keys().next().value
    if (oldest !== undefined) entries.delete(oldest)
  }

  return {
    async read(directory: string, model: string, probe: () => Promise<PiOptionsProbe>): Promise<PiOptionsProbe> {
      const scope = await projectDirs(directory)
      const key = JSON.stringify([scope, model])
      const before = await signature(scope)
      const held = entries.get(key)
      if (held && (held.signature === undefined || held.signature === before)) return await held.probe
      const entry: Entry = { probe: probe() }
      remember(key, entry)
      try {
        const answer = await entry.probe
        const after = await signature(scope)
        if (entries.get(key) !== entry) return answer
        if (after === before) entry.signature = after
        else entries.delete(key)
        return answer
      } catch (error) {
        if (entries.get(key) === entry) entries.delete(key)
        throw error
      }
    },
    clear() {
      entries.clear()
    },
  }
}
