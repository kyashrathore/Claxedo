import fs from "node:fs/promises"
import path from "node:path"
import { asRecordOrEmpty } from "@claxedo/helpers/guards"

/**
 * Whether the Claxedo desktop app's local daemon is running on this machine.
 *
 * The daemon publishes `local-daemon.json` in its data dir
 * (`claxedo-desktop/src/main/server-daemon-discovery.ts` writes it and owns
 * the shape) and answers `GET /api/claxedo/daemon` with the identity that
 * file names when shown the file's token. Only that answer counts as live: a
 * pid check would keep the guard up for as long as some other process holds
 * a crashed daemon's recycled pid, and under `RestartPreventExitStatus=78`
 * that is for ever. The desktop keeps one data dir per release channel
 * (`~/.claxedo`, `~/.claxedo-dev`, `~/.claxedo-beta`, or `CLAXEDO_DATA_DIR`
 * for any of them), so every one is probed.
 */

export type DesktopDaemonDiscovery = { pid: number; port: number; token: string; generation: string; protocol: number }

export type LiveDesktopDaemon = { pid: number; port: number; file: string }

const DAEMON_SERVICE = "claxedo-local-daemon"
const DESKTOP_CHANNEL_DIRS = [".claxedo", ".claxedo-dev", ".claxedo-beta"]
const VERIFY_TIMEOUT_MS = 1_500

export function desktopDaemonDiscoveryFiles(env: NodeJS.ProcessEnv, homedir: string) {
  const configured = env.CLAXEDO_DATA_DIR?.trim()
  const dirs = [...(configured ? [configured] : []), ...DESKTOP_CHANNEL_DIRS.map((dir) => path.join(homedir, dir))]
  return [...new Set(dirs)].map((dir) => path.join(dir, "local-daemon.json"))
}

function positiveInteger(value: unknown, max = Number.MAX_SAFE_INTEGER) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= max ? value : undefined
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

export function parseDesktopDaemonDiscovery(text: string): DesktopDaemonDiscovery | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  const record = asRecordOrEmpty(parsed)
  const pid = positiveInteger(record.pid)
  const port = positiveInteger(record.port, 65_535)
  const token = nonEmptyString(record.token)
  const generation = nonEmptyString(record.generation)
  const protocol = positiveInteger(record.protocol)
  if (record.service !== DAEMON_SERVICE || !pid || !port || !token || !generation || !protocol) return undefined
  return { pid, port, token, generation, protocol }
}

/** The daemon the record names answers on its port with the same identity. */
export async function verifyDesktopDaemon(record: DesktopDaemonDiscovery, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${record.port}/api/claxedo/daemon`, {
      headers: { authorization: `Bearer ${record.token}` },
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    })
    if (!response.ok) return false
    const identity = asRecordOrEmpty(await response.json())
    return (
      identity.service === DAEMON_SERVICE &&
      identity.protocol === record.protocol &&
      identity.generation === record.generation &&
      identity.pid === record.pid
    )
  } catch {
    return false
  }
}

/** The first discovery file whose daemon answers as itself; a file whose daemon does not is stale. */
export async function liveDesktopDaemon(input: {
  files: readonly string[]
  readFile?: (file: string) => Promise<string | undefined>
  verify?: (record: DesktopDaemonDiscovery) => Promise<boolean>
}): Promise<LiveDesktopDaemon | undefined> {
  const read = input.readFile ?? ((file) => fs.readFile(file, "utf8").catch(() => undefined))
  const verify = input.verify ?? verifyDesktopDaemon
  for (const file of input.files) {
    const text = await read(file)
    if (text === undefined) continue
    const daemon = parseDesktopDaemonDiscovery(text)
    if (!daemon || !(await verify(daemon))) continue
    return { pid: daemon.pid, port: daemon.port, file }
  }
  return undefined
}
