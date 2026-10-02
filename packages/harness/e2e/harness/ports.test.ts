import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"

const UNASSIGNABLE_PID = 4_194_305

async function bindable(port: number) {
  const server = net.createServer()
  const bound = await new Promise<boolean>((resolve) => {
    server.once("error", () => resolve(false))
    server.listen(port, "127.0.0.1", () => resolve(true))
  })
  if (!bound) return undefined
  const { port: assigned } = server.address() as net.AddressInfo
  await new Promise((resolve) => server.close(resolve))
  return assigned
}

/** Two adjacent ports nothing listens on, so only a lease can turn the first away. */
async function adjacentUnusedPorts() {
  for (;;) {
    const second = await bindable(0)
    if (second && second > 1024 && (await bindable(second - 1))) return [second - 1, second] as const
  }
}

// The lease directory and range are read when `ports.ts` loads, and the real
// ones are shared with every other e2e run on the machine; a child gets its
// own of both, so no other process can take or hold the ports it is asked about.
test("a port another live process leases is skipped, and a dead holder's lease is reclaimed", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "claxedo-port-leases-"))
  try {
    const [live, dead] = await adjacentUnusedPorts()
    const leases = path.join(tmp, "claxedo-e2e-port-leases")
    mkdirSync(leases)
    writeFileSync(path.join(leases, String(live)), String(process.pid))
    writeFileSync(path.join(leases, String(dead)), String(UNASSIGNABLE_PID))
    const env: Record<string, string | undefined> = { ...process.env, TMPDIR: tmp, CLAXEDO_E2E_PORT_RANGE: `${live}-${dead}` }
    delete env.CLAXEDO_E2E_DAEMON_PORT
    const child = Bun.spawn([process.execPath, "-e", `
      import { existsSync, readFileSync } from "node:fs"
      import { releasePort, reservePort } from ${JSON.stringify(path.join(import.meta.dir, "ports.ts"))}
      const port = await reservePort()
      const lease = readFileSync(${JSON.stringify(path.join(leases, String(dead)))}, "utf8")
      releasePort(port)
      console.log(JSON.stringify({ port, lease, pid: process.pid, released: !existsSync(${JSON.stringify(path.join(leases, String(dead)))}) }))
    `], { env, stdout: "pipe", stderr: "inherit" })
    expect(await child.exited).toBe(0)
    const result = JSON.parse(await new Response(child.stdout).text())
    expect(result).toEqual({ port: dead, lease: String(result.pid), pid: result.pid, released: true })
    expect(readFileSync(path.join(leases, String(live)), "utf8")).toBe(String(process.pid))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
