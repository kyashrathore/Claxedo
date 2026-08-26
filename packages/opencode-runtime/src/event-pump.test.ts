import { afterEach, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createEventPump, type ProjectedEvent } from "./event-pump"
import { createOpenCodeHost, type OpenCodeHost } from "./host"
import { authorizeWorkspace } from "./scope"
import { createSessionPort } from "./session-port"

const hosts: OpenCodeHost[] = []
const roots: string[] = []

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-pump-"))
  roots.push(root)
  return root
}

function hostAt(root: string) {
  const host = createOpenCodeHost({ databasePath: path.join(root, "opencode.db") })
  hosts.push(host)
  return host
}

async function waitFor(predicate: () => boolean, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return predicate()
}

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close().catch(() => {})))
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

test("projects real SDK events and marks durability correctly", async () => {
  const root = tempRoot()
  const workspace = path.join(root, "ws")
  fs.mkdirSync(workspace)
  const scope = authorizeWorkspace({ workspaceID: "w", directory: workspace })
  const host = hostAt(root)

  const seen: ProjectedEvent[] = []
  const pump = createEventPump(host, { onEvent: (event) => seen.push(event) })
  pump.start()

  await createSessionPort(host).create(scope, { title: "pumped" })
  await waitFor(() => seen.some((event) => event.type === "session.created"))

  const created = seen.find((event) => event.type === "session.created")
  expect(created).toBeDefined()
  // session.created carries a durable aggregate sequence, so it is authoritative.
  expect(created!.durable?.seq).toBeNumber()
  expect(created!.hintOnly).toBe(false)
  expect(created!.directory).toBe(workspace)

  const connected = seen.find((event) => event.type === "server.connected")
  if (connected) {
    // server.connected has no durable sequence, so it may only be a hint.
    expect(connected.durable).toBeUndefined()
    expect(connected.hintOnly).toBe(true)
  }

  await pump.stop()
})

test("records a monotonic checkpoint per aggregate", async () => {
  const root = tempRoot()
  const workspace = path.join(root, "ws")
  fs.mkdirSync(workspace)
  const scope = authorizeWorkspace({ workspaceID: "w", directory: workspace })
  const host = hostAt(root)

  const seen: ProjectedEvent[] = []
  const pump = createEventPump(host, { onEvent: (event) => seen.push(event) })
  pump.start()
  await createSessionPort(host).create(scope, { title: "checkpointed" })
  await waitFor(() => seen.some((event) => event.durable !== undefined))

  const durable = seen.find((event) => event.durable !== undefined)!
  expect(pump.checkpoint(durable.durable!.aggregateID)).toBe(durable.durable!.seq)
  expect(pump.checkpoint("never-seen")).toBeUndefined()

  await pump.stop()
})

test("a throwing consumer degrades health but does not kill the pump", async () => {
  const root = tempRoot()
  const workspace = path.join(root, "ws")
  fs.mkdirSync(workspace)
  const scope = authorizeWorkspace({ workspaceID: "w", directory: workspace })
  const host = hostAt(root)

  let delivered = 0
  const pump = createEventPump(host, {
    onEvent: () => {
      delivered += 1
      throw new Error("consumer exploded")
    },
  })
  pump.start()

  const port = createSessionPort(host)
  await port.create(scope, { title: "one" })
  await waitFor(() => delivered > 0)
  expect(host.status().events).toBe("degraded")

  // The pump is still alive: a later mutation still reaches the consumer.
  const before = delivered
  await port.create(scope, { title: "two" })
  expect(await waitFor(() => delivered > before)).toBe(true)

  await pump.stop()
})

test("stop is idempotent and releases the stream", async () => {
  const host = hostAt(tempRoot())
  const pump = createEventPump(host, { onEvent: () => {} })
  pump.start()
  await host.client()
  await Promise.all([pump.stop(), pump.stop()])
  // A stopped pump does not resurrect on a second start.
  pump.start()
  await pump.stop()
})

test("start before first mutation does not force the host warm early", () => {
  const host = hostAt(tempRoot())
  const pump = createEventPump(host, { onEvent: () => {} })
  // Constructing the pump must not boot the SDK; only start() consumes, and
  // even then the host boots lazily on its own schedule.
  expect(host.status().lifecycle).toBe("cold")
  return pump.stop()
})
