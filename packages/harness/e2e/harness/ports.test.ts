import { expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { PORT_RANGE, releasePort, reservePort } from "./ports"

const LEASES = path.join(os.tmpdir(), "claxedo-e2e-port-leases")
const UNASSIGNABLE_PID = 4_194_305

test("a port another live process leases is skipped, and a dead holder's lease is reclaimed", async () => {
  const live = PORT_RANGE.first
  const dead = PORT_RANGE.first + 1
  mkdirSync(LEASES, { recursive: true })
  writeFileSync(path.join(LEASES, String(live)), String(process.ppid))
  writeFileSync(path.join(LEASES, String(dead)), String(UNASSIGNABLE_PID))
  const taken: number[] = []
  try {
    const port = await reservePort()
    taken.push(port)
    expect(port).not.toBe(live)
    expect(port).toBe(dead)
    expect(readFileSync(path.join(LEASES, String(dead)), "utf8")).toBe(String(process.pid))
    releasePort(port)
    expect(existsSync(path.join(LEASES, String(dead)))).toBe(false)
    expect(readFileSync(path.join(LEASES, String(live)), "utf8")).toBe(String(process.ppid))
  } finally {
    for (const port of taken) releasePort(port)
    rmSync(path.join(LEASES, String(live)), { force: true })
    rmSync(path.join(LEASES, String(dead)), { force: true })
  }
})
