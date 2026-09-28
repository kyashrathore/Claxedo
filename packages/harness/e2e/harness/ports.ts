import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs"
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
  if (!Number.isSafeInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function takeLease(port: number) {
  mkdirSync(LEASE_DIR, { recursive: true })
  const file = leaseFile(port)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(file, "wx")
      writeSync(fd, String(process.pid))
      closeSync(fd)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      if (holderAlive(file)) return false
      rmSync(file, { force: true })
    }
  }
  return false
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

async function portIsFree(port: number) {
  const server = net.createServer()
  return await new Promise<boolean>((resolve) => {
    server.once("error", () => resolve(false))
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)))
  })
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
