import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createServer } from "node:http"
import { shutdownPackagedTestDaemon } from "./desktop-daemon"

test("teardown refuses malformed discovery without deleting the profile", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-daemon-invalid-"))
  const dir = path.join(root, "server-data")
  try {
    await fs.mkdir(dir)
    const file = path.join(dir, "local-daemon.json")
    await fs.writeFile(file, "{broken")
    await expect(shutdownPackagedTestDaemon(root)).rejects.toThrow("discovery is invalid")
    expect(await fs.readFile(file, "utf8")).toBe("{broken")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("teardown never mutates a listener with a different process generation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-daemon-identity-"))
  let mutations = 0
  const server = createServer((request, response) => {
    if (["POST", "PUT", "DELETE"].includes(request.method ?? "")) mutations++
    response.setHeader("access-control-allow-origin", "*")
    response.setHeader("access-control-allow-headers", "authorization")
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ service: "claxedo-local-daemon", protocol: 1, pid: process.pid, generation: "other-generation" }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing test listener address")
  try {
    await fs.mkdir(path.join(root, "server-data"))
    await fs.writeFile(path.join(root, "server-data/local-daemon.json"), JSON.stringify({
      service: "claxedo-local-daemon", protocol: 1, generation: "test-generation",
      token: "test-token", pid: process.pid, port: address.port, startedAt: new Date().toISOString(),
    }))
    await expect(shutdownPackagedTestDaemon(root)).rejects.toThrow("identity could not be verified")
    expect(mutations).toBe(0)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fs.rm(root, { recursive: true, force: true })
  }
})
