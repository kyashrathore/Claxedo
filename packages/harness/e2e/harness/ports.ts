import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import type { Server } from "node:http"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { sleep } from "@claxedo/helpers"

function portRange() {
  const match = /^(\d+)-(\d+)$/.exec(process.env.CLAXEDO_E2E_PORT_RANGE ?? "")
  return match ? { first: Number(match[1]), last: Number(match[2]) } : { first: 46100, last: 46199 }
}

export const PORT_RANGE = portRange()

const leased = new Set<number>()

const LEASE_DIR = path.join(os.tmpdir(), "claxedo-e2e-port-leases")

function leaseFile(port: number) {
  return path.join(LEASE_DIR, String(port))
}

function holderAlive(file: string) {
  let pid: number
  try { pid = Number(readFileSync(file, "utf8")) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
  if (!Number.isSafeInteger(pid) || pid <= 1) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function reclaimLease(file: string) {
  const guard = `${file}.reclaim`
  try { mkdirSync(guard) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false
    throw error
  }
  try {
    if (holderAlive(file)) return false
    rmSync(file, { force: true })
    return true
  } finally {
    rmSync(guard, { recursive: true })
  }
}

function takeLease(port: number) {
  mkdirSync(LEASE_DIR, { recursive: true })
  const file = leaseFile(port)
  const candidate = path.join(LEASE_DIR, `.candidate-${process.pid}-${randomUUID()}`)
  writeFileSync(candidate, String(process.pid), { flag: "wx", mode: 0o600 })
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        linkSync(candidate, file)
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        if (!reclaimLease(file)) return false
      }
    }
    return false
  } finally {
    rmSync(candidate)
  }
}

function dropLease(port: number) {
  const file = leaseFile(port)
  let holder: string
  try { holder = readFileSync(file, "utf8") }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  if (holder === String(process.pid)) rmSync(file, { force: true })
}

function connectionRefused(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect(port, "127.0.0.1")
    socket.once("connect", () => { socket.destroy(); resolve(false) })
    socket.once("error", (error: NodeJS.ErrnoException) => resolve(error.code === "ECONNREFUSED"))
  })
}

/**
 * The probe listener's close callback can run before the kernel has released
 * the port (observed on Windows), so a port only counts as free once a connect
 * to it is refused.
 */
async function portIsFree(port: number) {
  const server = net.createServer()
  const probed = await new Promise<boolean>((resolve) => {
    server.once("error", () => resolve(false))
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)))
  })
  if (!probed) return false
  const deadline = Date.now() + 2_000
  while (!(await connectionRefused(port))) {
    if (Date.now() > deadline) return false
    await sleep(20)
  }
  return true
}

export async function reservePort(): Promise<number> {
  const daemonPort = fixedDaemonPort()
  for (let port = PORT_RANGE.first; port <= PORT_RANGE.last; port += 1) {
    if (leased.has(port) || port === daemonPort) continue
    if (!takeLease(port)) continue
    if (!(await portIsFree(port))) {
      dropLease(port)
      continue
    }
    leased.add(port)
    return port
  }
  throw new Error(`No free port left in ${PORT_RANGE.first}-${PORT_RANGE.last}`)
}

export function portIsLeased(port: number) {
  return leased.has(port)
}

export async function portFreed(port: number, withinMs: number) {
  const deadline = Date.now() + withinMs
  while (!(await portIsFree(port))) {
    if (Date.now() > deadline) return false
    await sleep(100)
  }
  return true
}

export async function claimPort(port: number) {
  if (port < PORT_RANGE.first || port > PORT_RANGE.last) throw new Error(`Port ${port} is outside ${PORT_RANGE.first}-${PORT_RANGE.last}`)
  if (!takeLease(port) || !(await portFreed(port, 10_000))) {
    dropLease(port)
    throw new Error(`Port ${port} is held by another process; the app is built for it. Give this run its own CLAXEDO_E2E_PORT_RANGE.`)
  }
  leased.add(port)
  return port
}

export function releasePort(port: number) {
  leased.delete(port)
  dropLease(port)
}

export const DAEMON_PORT_ENV = "CLAXEDO_E2E_DAEMON_PORT"

export function fixedDaemonPort(): number | undefined {
  const value = process.env[DAEMON_PORT_ENV]
  if (!value) return undefined
  const port = Number(value)
  if (!Number.isInteger(port)) throw new Error(`${DAEMON_PORT_ENV}="${value}" is not a port`)
  return port
}

export function listenOnLoopback(server: Server, port: number) {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", resolve)
  })
}
