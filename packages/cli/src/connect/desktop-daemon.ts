import fs from "node:fs/promises"
import path from "node:path"
import { asFiniteNumber, asRecordOrEmpty } from "@claxedo/helpers/guards"

/**
 * The desktop's local daemon publishes `local-daemon.json` under its data
 * dir (`claxedo-desktop/src/main/server-daemon-discovery.ts` writes it and
 * owns the shape). The daemon is already enrolled as this machine under the
 * signed-in account and serves its folders; a `claxedo connect` host on the
 * same box is a second machine with its own key. Running both is a choice
 * the operator states with `--alongside-desktop`, never a default.
 */

export type LiveDesktopDaemon = { pid: number; port: number; file: string }

const DAEMON_SERVICE = "claxedo-local-daemon"

export function desktopDaemonDiscoveryFile(env: NodeJS.ProcessEnv, homedir: string) {
  const dataDir = env.CLAXEDO_DATA_DIR?.trim()
  return path.join(dataDir || path.join(homedir, ".claxedo"), "local-daemon.json")
}

export function parseDesktopDaemonDiscovery(text: string): { pid: number; port: number } | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  const record = asRecordOrEmpty(parsed)
  const pid = asFiniteNumber(record.pid)
  const port = asFiniteNumber(record.port)
  if (record.service !== DAEMON_SERVICE || pid === undefined || port === undefined) return undefined
  return { pid, port }
}

export function processAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** The daemon the discovery file names, when that process is still alive; a stale file is no daemon. */
export async function liveDesktopDaemon(input: {
  file: string
  readFile?: (file: string) => Promise<string | undefined>
  pidAlive?: (pid: number) => boolean
}): Promise<LiveDesktopDaemon | undefined> {
  const read = input.readFile ?? ((file) => fs.readFile(file, "utf8").catch(() => undefined))
  const alive = input.pidAlive ?? processAlive
  const text = await read(input.file)
  if (text === undefined) return undefined
  const daemon = parseDesktopDaemonDiscovery(text)
  if (!daemon || !alive(daemon.pid)) return undefined
  return { ...daemon, file: input.file }
}
