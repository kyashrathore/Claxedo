import { describe, expect, mock, test } from "bun:test"
import { spawn } from "node:child_process"
import { holdClaxedoDaemonLease } from "./server-daemon-lease"
import type { ClaxedoDaemonDiscovery } from "./server-daemon-discovery"

type Seen = { method: string; path: string; authorization?: string; capability?: string; body: string }

/**
 * Bun's own http server reports nothing when a client closes a response it is
 * still holding, so the fake daemon runs on Node, as the real one does.
 */
const FAKE_DAEMON = `
const http = require("node:http")
const options = JSON.parse(process.argv[1])
const report = (event) => process.stdout.write(JSON.stringify(event) + "\\n")
const held = []
process.stdin.on("data", () => held.splice(0).forEach((response) => response.destroy()))
const server = http.createServer((request, response) => {
  const path = request.url
  const lease = request.method === "POST" && path === "/api/claxedo/daemon/leases"
  if (lease) request.socket.once("close", () => report({ event: "lease closed" }))
  let body = ""
  request.on("data", (chunk) => (body += chunk))
  request.on("end", () => {
    report({ event: request.method + " " + path, seen: { method: request.method, path, authorization: request.headers.authorization, capability: request.headers["x-claxedo-daemon-capability"], body } })
    if (lease) {
      if (options.acquire && options.acquire !== 201) return response.writeHead(options.acquire).end()
      response.writeHead(201, { "content-type": "application/x-ndjson" })
      response.write(JSON.stringify({ id: "lease-1", client: "electron-main" }) + "\\n")
      held.push(response)
      return
    }
    response.writeHead(404).end()
  })
})
server.listen(0, "127.0.0.1", () => report({ port: server.address().port }))
`

async function fakeDaemon(options: { acquire?: number } = {}) {
  const seen: Seen[] = []
  const events: string[] = []
  const child = spawn("node", ["-e", FAKE_DAEMON, JSON.stringify(options)], { stdio: ["pipe", "pipe", "inherit"] })
  const port = await new Promise<number>((resolve) => {
    let buffered = ""
    child.stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString()
      for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
        const line = JSON.parse(buffered.slice(0, end)) as { port?: number; event?: string; seen?: Seen }
        buffered = buffered.slice(end + 1)
        if (line.port) resolve(line.port)
        if (line.event) events.push(line.event)
        if (line.seen) seen.push(line.seen)
      }
    })
  })
  const discovery: ClaxedoDaemonDiscovery = {
    service: "claxedo-local-daemon",
    protocol: 3,
    generation: "generation-1",
    token: "secret-token",
    pid: 42,
    port,
    startedAt: "2026-08-27T00:00:00.000Z",
    build: "1.4.0",
  }
  return {
    discovery,
    seen,
    events,
    endLease: () => child.stdin.write("end\n"),
    settle: () => new Promise((resolve) => setTimeout(resolve, 100)),
    close: () => {
      child.kill()
    },
  }
}

describe("Claxedo daemon client lease", () => {
  test("is one open connection that presents the capability, and stopping it is not a loss", async () => {
    const daemon = await fakeDaemon()
    try {
      const onLost = mock(() => {})
      const held = await holdClaxedoDaemonLease(daemon.discovery, { onLost })
      expect(held.id).toBe("lease-1")
      expect(held).not.toHaveProperty("token")

      await held.stop()
      await daemon.settle()
      expect(daemon.events).toEqual(["POST /api/claxedo/daemon/leases", "lease closed"])
      expect(onLost).not.toHaveBeenCalled()
      // Two presentations of one published secret: the lifecycle route reads the
      // bearer, the admission gate ahead of it reads the capability.
      expect(daemon.seen[0]).toMatchObject({ authorization: "Bearer secret-token", capability: "secret-token" })
    } finally {
      daemon.close()
    }
  })

  test("quit releases only its lease and a reopened desktop can acquire another", async () => {
    const daemon = await fakeDaemon()
    try {
      await (await holdClaxedoDaemonLease(daemon.discovery)).stop()
      await daemon.settle()
      await (await holdClaxedoDaemonLease(daemon.discovery)).stop()
      await daemon.settle()
      expect(daemon.events).toEqual([
        "POST /api/claxedo/daemon/leases", "lease closed",
        "POST /api/claxedo/daemon/leases", "lease closed",
      ])
    } finally {
      daemon.close()
    }
  })

  test("a lease the daemon ends is reported lost once, and nothing reacquires it", async () => {
    const daemon = await fakeDaemon()
    try {
      const onLost = mock(() => {})
      await holdClaxedoDaemonLease(daemon.discovery, { onLost })
      await daemon.settle()
      daemon.endLease()
      await daemon.settle()

      expect(onLost).toHaveBeenCalledTimes(1)
      expect(daemon.events.filter((event) => event === "POST /api/claxedo/daemon/leases")).toHaveLength(1)
    } finally {
      daemon.close()
    }
  })

  test("a daemon that dies is one lost lease and no error, and nothing reacquires it", async () => {
    const daemon = await fakeDaemon()
    try {
      const onLost = mock(() => {})
      const onError = mock(() => {})
      await holdClaxedoDaemonLease(daemon.discovery, { onLost, onError })
      await daemon.settle()
      daemon.close()
      await daemon.settle()

      expect(onLost).toHaveBeenCalledTimes(1)
      expect(onError).not.toHaveBeenCalled()
      expect(daemon.events.filter((event) => event === "POST /api/claxedo/daemon/leases")).toHaveLength(1)
    } finally {
      daemon.close()
    }
  })

  test("a lease the daemon refuses is an error, not a held lease", async () => {
    const daemon = await fakeDaemon({ acquire: 409 })
    try {
      await expect(holdClaxedoDaemonLease(daemon.discovery)).rejects.toThrow("daemon lease acquire failed (409)")
    } finally {
      daemon.close()
    }
  })
})
