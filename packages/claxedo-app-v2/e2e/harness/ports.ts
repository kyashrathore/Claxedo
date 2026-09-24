import net from "node:net"

function portRange() {
  const match = /^(\d+)-(\d+)$/.exec(process.env.CLAXEDO_E2E_PORT_RANGE ?? "")
  return match ? { first: Number(match[1]), last: Number(match[2]) } : { first: 46100, last: 46199 }
}

export const PORT_RANGE = portRange()

const leased = new Set<number>()

async function portIsFree(port: number) {
  const server = net.createServer()
  return await new Promise<boolean>((resolve) => {
    server.once("error", () => resolve(false))
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)))
  })
}

export async function reservePort(): Promise<number> {
  for (let port = PORT_RANGE.first; port <= PORT_RANGE.last; port += 1) {
    if (leased.has(port)) continue
    if (!(await portIsFree(port))) continue
    leased.add(port)
    return port
  }
  throw new Error(`No free port left in ${PORT_RANGE.first}-${PORT_RANGE.last}`)
}

export function portIsLeased(port: number) {
  return leased.has(port)
}

export async function claimPort(port: number) {
  if (port < PORT_RANGE.first || port > PORT_RANGE.last) throw new Error(`Port ${port} is outside ${PORT_RANGE.first}-${PORT_RANGE.last}`)
  if (!(await portIsFree(port))) {
    throw new Error(`Port ${port} is held by another process; the app is built for it. Give this run its own CLAXEDO_E2E_PORT_RANGE.`)
  }
  leased.add(port)
  return port
}

export function releasePort(port: number) {
  leased.delete(port)
}

export const DAEMON_PORT_ENV = "CLAXEDO_E2E_DAEMON_PORT"

export function fixedDaemonPort(): number | undefined {
  const value = process.env[DAEMON_PORT_ENV]
  if (!value) return undefined
  const port = Number(value)
  if (!Number.isInteger(port)) throw new Error(`${DAEMON_PORT_ENV}="${value}" is not a port`)
  return port
}
