/**
 * These run against the REAL pinned SDK, not a fake. The whole point of this
 * package is that it is the only thing that touches the SDK, so a mock here
 * would test nothing that matters.
 */
import { afterEach, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createOpenCodeHost, OpenCodeUnavailableError, type OpenCodeHost } from "./host"
import { authorizeWorkspace, WorkspaceScopeError } from "./scope"
import { createSessionPort } from "./session-port"

const hosts: OpenCodeHost[] = []
const roots: string[] = []

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-runtime-"))
  roots.push(root)
  return root
}

function hostAt(root: string) {
  const host = createOpenCodeHost({ databasePath: path.join(root, "opencode.db") })
  hosts.push(host)
  return host
}

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close().catch(() => {})))
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

test("rejects a relative database path instead of silently using :memory:", () => {
  expect(() => createOpenCodeHost({ databasePath: "relative/opencode.db" })).toThrow(/absolute/)
})

test("starts cold and does not boot the SDK until first use", () => {
  const root = tempRoot()
  const host = hostAt(root)
  expect(host.status().lifecycle).toBe("cold")
  // Laziness is load-bearing: cold shell hydration must not create the host.
  expect(fs.existsSync(path.join(root, "opencode.db"))).toBe(false)
})

test("concurrent first use shares one host and one database opener", async () => {
  const host = hostAt(tempRoot())
  const [a, b, c] = await Promise.all([host.client(), host.client(), host.client()])
  expect(a).toBe(b)
  expect(b).toBe(c)
  expect(host.status().lifecycle).toBe("ready")
})

test("event health is orthogonal to lifecycle", async () => {
  const host = hostAt(tempRoot())
  await host.client()
  host.setEventHealth("degraded")
  // A ready host with a degraded stream must stay describable as exactly that.
  expect(host.status()).toMatchObject({ lifecycle: "ready", events: "degraded" })
})

test("a closed owner is terminal and never reopens", async () => {
  const host = hostAt(tempRoot())
  await host.client()
  await host.close()
  expect(host.status().lifecycle).toBe("closed")
  await expect(host.client()).rejects.toBeInstanceOf(OpenCodeUnavailableError)
})

test("repeated shutdown is safe", async () => {
  const host = hostAt(tempRoot())
  await host.client()
  await Promise.all([host.close(), host.close(), host.close()])
  expect(host.status().lifecycle).toBe("closed")
})

test("sessions persist across a fresh owner on the same database", async () => {
  const root = tempRoot()
  const workspace = path.join(root, "ws")
  fs.mkdirSync(workspace)
  const scope = authorizeWorkspace({ workspaceID: "ws-1", directory: workspace })

  const first = hostAt(root)
  const created = await createSessionPort(first).create(scope, { title: "persisted" })
  await first.close()

  // A fresh owner stands in for a process restart.
  const second = hostAt(root)
  const reread = await createSessionPort(second).get(scope, created.id)
  expect(reread.id).toBe(created.id)
  expect(reread.title).toBe("persisted")
})

test("a cross-workspace session id fails closed", async () => {
  const root = tempRoot()
  const a = path.join(root, "ws-a")
  const b = path.join(root, "ws-b")
  fs.mkdirSync(a)
  fs.mkdirSync(b)
  const scopeA = authorizeWorkspace({ workspaceID: "ws-a", directory: a })
  const scopeB = authorizeWorkspace({ workspaceID: "ws-b", directory: b })

  const port = createSessionPort(hostAt(root))
  const inB = await port.create(scopeB, { title: "belongs to b" })

  // The SDK itself WILL return this session to any caller (contract doc §4).
  // The scope check is the only barrier, so this must reject.
  await expect(port.get(scopeA, inB.id)).rejects.toBeInstanceOf(WorkspaceScopeError)
})

test("listing is scoped to the authorized workspace", async () => {
  const root = tempRoot()
  const a = path.join(root, "ws-a")
  const b = path.join(root, "ws-b")
  fs.mkdirSync(a)
  fs.mkdirSync(b)
  const scopeA = authorizeWorkspace({ workspaceID: "ws-a", directory: a })
  const scopeB = authorizeWorkspace({ workspaceID: "ws-b", directory: b })

  const port = createSessionPort(hostAt(root))
  const inA = await port.create(scopeA, { title: "a" })
  const inB = await port.create(scopeB, { title: "b" })

  const page = await port.list(scopeA)
  const ids = page.sessions.map((session) => session.id)
  expect(ids).toContain(inA.id)
  expect(ids).not.toContain(inB.id)
})

test("remove proves ownership before destroying", async () => {
  const root = tempRoot()
  const a = path.join(root, "ws-a")
  const b = path.join(root, "ws-b")
  fs.mkdirSync(a)
  fs.mkdirSync(b)
  const scopeA = authorizeWorkspace({ workspaceID: "ws-a", directory: a })
  const scopeB = authorizeWorkspace({ workspaceID: "ws-b", directory: b })

  const port = createSessionPort(hostAt(root))
  const inB = await port.create(scopeB, { title: "b" })

  await expect(port.remove(scopeA, inB.id)).rejects.toBeInstanceOf(WorkspaceScopeError)
  // ...and it really is still there.
  expect((await port.get(scopeB, inB.id)).id).toBe(inB.id)
})
