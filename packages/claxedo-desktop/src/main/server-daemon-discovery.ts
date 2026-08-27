import fs from "node:fs"
import path from "node:path"

export const CLAXEDO_DAEMON_PROTOCOL = 1
export const CLAXEDO_DAEMON_SERVICE = "claxedo-local-daemon" as const

export type ClaxedoDaemonDiscovery = Readonly<{
  service: typeof CLAXEDO_DAEMON_SERVICE
  protocol: typeof CLAXEDO_DAEMON_PROTOCOL
  generation: string
  token: string
  pid: number
  port: number
  startedAt: string
}>

export function claxedoDaemonDiscoveryPath(dataRoot: string) {
  return path.join(dataRoot, "local-daemon.json")
}

export function readClaxedoDaemonDiscovery(file: string): ClaxedoDaemonDiscovery | undefined {
  try {
    return parseDiscovery(JSON.parse(fs.readFileSync(file, "utf8")))
  } catch (error) {
    if (isNodeError(error, "ENOENT") || error instanceof SyntaxError) return
    throw error
  }
}

export function writeClaxedoDaemonDiscovery(file: string, record: ClaxedoDaemonDiscovery) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 })
    fs.renameSync(temporary, file)
    fs.chmodSync(file, 0o600)
  } finally {
    try {
      fs.unlinkSync(temporary)
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error
    }
  }
}

export function clearClaxedoDaemonDiscovery(file: string, owner: ClaxedoDaemonDiscovery) {
  const current = readClaxedoDaemonDiscovery(file)
  if (!current || current.pid !== owner.pid || current.generation !== owner.generation || current.token !== owner.token) {
    return
  }
  try {
    fs.unlinkSync(file)
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error
  }
}

export async function verifyClaxedoDaemonDiscovery(
  record: ClaxedoDaemonDiscovery,
  request: typeof fetch = fetch,
): Promise<string | undefined> {
  const url = `http://127.0.0.1:${String(record.port)}`
  try {
    const response = await request(`${url}/api/claxedo/daemon`, {
      headers: { authorization: `Bearer ${record.token}` },
      signal: AbortSignal.timeout(1_500),
    })
    if (!response.ok) return
    const identity = await response.json() as Record<string, unknown>
    if (
      identity.service !== record.service ||
      identity.protocol !== record.protocol ||
      identity.generation !== record.generation ||
      identity.pid !== record.pid
    ) return
    return url
  } catch {
    return
  }
}

function parseDiscovery(value: unknown): ClaxedoDaemonDiscovery | undefined {
  if (!value || typeof value !== "object") return
  const record = value as Record<string, unknown>
  if (
    record.service !== CLAXEDO_DAEMON_SERVICE ||
    record.protocol !== CLAXEDO_DAEMON_PROTOCOL ||
    typeof record.generation !== "string" || !record.generation ||
    typeof record.token !== "string" || !record.token ||
    typeof record.pid !== "number" || !Number.isSafeInteger(record.pid) || record.pid <= 0 ||
    typeof record.port !== "number" || !Number.isSafeInteger(record.port) || record.port <= 0 || record.port > 65535 ||
    typeof record.startedAt !== "string" || !record.startedAt
  ) return
  return record as ClaxedoDaemonDiscovery
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code
}
