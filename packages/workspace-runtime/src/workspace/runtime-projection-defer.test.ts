import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ResolvedCredentials, TransportConfigUpdate } from "@claxedo/harness/contract"
import { Hono } from "hono"
import { withWorkspaceTarget } from "../target"
import { loopbackWorkspaceRuntimeExposure } from "../exposure"
import { FakeTransport, fakeConnectionProvider } from "../test-support/fake-transport"
import { loopbackMachineLoginPolicy } from "../testing"
import { createWorkspaceHost } from "./runtime"
import type { RuntimeSnapshot } from "../routes/config"

/**
 * A harness may hold a credential rotation until its running turn ends, as Pi
 * does: the placeholder lives in a profile file the running process reads. A
 * renewal push is one every half-lifetime, so a session longer than that meets
 * the hold on every one, and none of them may fail the whole config apply.
 */
const cleanups: Array<() => void | Promise<void>> = []
const roots: string[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** Fixed so two snapshots differ by exactly what a test changed. */
const EXPIRES_AT = Date.now() + 60 * 60 * 1000

function snapshot(placeholder: string, mcp: Record<string, unknown> = {}): RuntimeSnapshot {
  return {
    version: 4, commands: [],
    mcp,
    connections: [{ connectionId: "fixture", providerKey: "fixture", configRevision: 1, enabled: true, config: {} }],
    defaultHarness: { kind: "connection", connectionId: "fixture" },
    auth: {
      pi: {
        baseUrl: "http://127.0.0.1:2595/bindings/pi1",
        placeholder,
        authMode: "bearer",
        expiresAt: EXPIRES_AT,
      },
    },
  }
}

function placeholderOf(credentials: ResolvedCredentials | undefined) {
  const projection = credentials?.providers.pi
  return projection && "placeholder" in projection ? projection.placeholder : undefined
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "projection-defer-"))
  roots.push(directory)
  const target = { workspaceId: "ws_defer", directory }
  const applied: TransportConfigUpdate[] = []
  const placeholders: string[] = []
  let started = () => {}
  const startedTurn = new Promise<void>((resolve) => { started = resolve })
  let release = () => {}
  const heldTurn = new Promise<void>((resolve) => { release = resolve })
  let refuseHeld = false
  const transport = new FakeTransport({
    onStart: (start) => { const placeholder = placeholderOf(start.credentials); if (placeholder) placeholders.push(placeholder) },
    // A credential push during a turn is held; one that also moves the
    // projection cannot be held back and is refused while the process runs.
    configure: (update, self) => {
      if (self.activeTurns > 0 && update.credentials) {
        return update.projection
          ? { state: "refused", reason: "Cannot rotate Pi credentials during an active turn" }
          : { state: "deferred", until: "after-active-turns" }
      }
      if (refuseHeld && update.credentials) return { state: "refused", reason: "the profile could not be written" }
      applied.push(update)
      const placeholder = placeholderOf(update.credentials)
      if (placeholder && !placeholders.includes(placeholder)) placeholders.push(placeholder)
      return { state: "applied" }
    },
    turn: async function* ({ session }) {
      started()
      await heldTurn
      yield { type: "text-delta", delta: "answer" }
      yield { type: "finish", sessionId: session.binding.sessionId }
    },
  })
  const host = createWorkspaceHost({
    placement: loopbackMachineLoginPolicy(),
    target,
    storeRoot: join(directory, "state"),
    harnessStateRoot: join(directory, "harness"),
    connectionProviders: [fakeConnectionProvider({ providerKey: "fixture", transport: () => transport })],
  })
  cleanups.push(() => host.dispose())
  cleanups.push(release)
  const app = new Hono()
  host.mount(app, { exposure: loopbackWorkspaceRuntimeExposure() })
  const request = (pathname: string, method = "GET", body?: unknown) => withWorkspaceTarget(target, () => app.request(
    `http://runtime.test${pathname}?directory=${encodeURIComponent(directory)}`,
    { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) },
  ))
  return { host, request, applied, startedTurn, release, refuseHeld: () => { refuseHeld = true }, placeholders: () => [...placeholders] }
}

test("a renewal pushed into a running turn is held, not failed, and lands when the turn ends", async () => {
  const f = await fixture()
  await f.host.apply(snapshot("first"))
  expect((await f.request("/session", "POST", { id: "held" })).status).toBe(201)
  expect(f.placeholders()).toEqual(["first"])

  const prompt = f.request("/session/held/message", "POST", { parts: [{ type: "text", text: "go" }] })
  await f.startedTurn

  await f.host.apply(snapshot("renewed"))
  expect(f.host.detail().configApply?.state).toBe("applied")
  expect(f.placeholders()).toEqual(["first"])

  f.release()
  await prompt
  for (let flush = 0; flush < 100 && f.placeholders().length < 2; flush++) await new Promise((resolve) => setTimeout(resolve, 1))

  expect(f.placeholders()).toEqual(["first", "renewed"])
})

test("a change the running turn's harness also reads is applied rather than held", async () => {
  const f = await fixture()
  await f.host.apply(snapshot("first"))
  expect((await f.request("/session", "POST", { id: "held" })).status).toBe(201)

  const prompt = f.request("/session/held/message", "POST", { parts: [{ type: "text", text: "go" }] })
  await f.startedTurn

  // Not projection-only: the MCP map changed too, and holding that back would
  // leave the apply claiming a server the runtime never handed over.
  const mcp = { docs: { name: "docs", transport: "stdio", command: "docs", args: [], env: {} } }
  await f.host.apply(snapshot("first", mcp))

  expect(f.host.detail().configApply?.state).toBe("applied")
  expect(f.applied.at(-1)?.projection?.mcpServers).toMatchObject([{ kind: "stdio", name: "docs", command: "docs" }])

  f.release()
  await prompt
})

test("a rotation the harness refuses mid-turn fails the apply rather than being reported applied", async () => {
  const f = await fixture()
  await f.host.apply(snapshot("first"))
  expect((await f.request("/session", "POST", { id: "held" })).status).toBe(201)

  const prompt = f.request("/session/held/message", "POST", { parts: [{ type: "text", text: "go" }] })
  await f.startedTurn

  // The placeholder AND the MCP map move together, so nothing can be held back
  // and the harness is asked to rotate while it is talking to the process.
  await expect(f.host.apply(snapshot("renewed", { docs: { name: "docs", transport: "stdio", command: "docs", args: [], env: {} } }))).rejects.toThrow("refused")
  expect(f.host.detail().configApply).toMatchObject({ state: "failed", error: { code: "runtime_config_refused" } })

  f.release()
  await prompt
})

test("retrying the identical refused snapshot resends its credentials and projection", async () => {
  const f = await fixture()
  await f.host.apply(snapshot("first"))
  expect((await f.request("/session", "POST", { id: "held" })).status).toBe(201)
  const prompt = f.request("/session/held/message", "POST", { parts: [{ type: "text", text: "go" }] })
  await f.startedTurn
  const next = snapshot("renewed", { docs: { name: "docs", transport: "stdio", command: "docs", args: [], env: {} } })
  await expect(f.host.apply(next)).rejects.toThrow("refused")
  f.release()
  await prompt
  await f.host.apply(next)
  expect(f.host.detail().configApply?.state).toBe("applied")
  expect(f.placeholders()).toEqual(["first", "renewed"])
  expect(f.applied.at(-1)?.projection?.mcpServers).toMatchObject([{ kind: "stdio", name: "docs" }])
})

test("a held config that fails when the turn ends is reported, not swallowed", async () => {
  const f = await fixture()
  await f.host.apply(snapshot("first"))
  expect((await f.request("/session", "POST", { id: "held" })).status).toBe(201)

  const prompt = f.request("/session/held/message", "POST", { parts: [{ type: "text", text: "go" }] })
  await f.startedTurn
  await f.host.apply(snapshot("renewed"))
  // `applied` is what the snapshot's own apply could honestly claim; the half
  // it deferred has not run yet.
  expect(f.host.detail().configApply?.state).toBe("applied")

  f.refuseHeld()
  f.release()
  await prompt
  for (let flush = 0; flush < 200 && f.host.detail().configApply?.state === "applied"; flush++) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }

  expect(f.host.detail().configApply).toMatchObject({ state: "failed", error: { code: "runtime_config_refused" } })
  expect(f.placeholders()).toEqual(["first"])
})
