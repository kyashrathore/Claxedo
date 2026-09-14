import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import type { AgentSession } from "@claxedo/agent-sdk-runtime"
import type { AgentHarnessAdapter } from "@claxedo/agent-sdk-runtime/adapters"
import { withWorkspaceTarget } from "../target"
import { loopbackWorkspaceRuntimeExposure } from "../exposure"
import { createWorkspaceHost } from "./runtime"
import type { RuntimeSnapshot } from "../routes/config"

/**
 * Pi refuses to rotate its placeholder while a turn is running — the profile
 * file the placeholder lives in is read by the process the turn is talking to.
 * A renewal push is one every half-lifetime, so a session longer than that met
 * the refusal on every single one, and each failed the whole config apply.
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
    version: 4,
    mcp,
    connections: [],
    defaultHarness: { kind: "native", harnessId: "pi" },
    // Non-empty and unchanged across renewals: an empty launch map compares
    // equal to the whole map as well as to this harness's own entry, and hides
    // a comparison reading the wrong one of the two.
    harnessLaunch: { pi: { agentDir: "/profiles/pi" } },
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

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "projection-defer-"))
  roots.push(directory)
  const target = { workspaceId: "ws_defer", directory }

  const upstream = new Map<string, AgentSession>()
  const applied: Array<Record<string, unknown>> = []
  let projected: string | undefined
  let turns = 0
  let started = () => {}
  const startedTurn = new Promise<void>((resolve) => { started = resolve })
  let release = () => {}
  const heldTurn = new Promise<void>((resolve) => { release = resolve })

  let refuseHeldApply = false
  const adapter: AgentHarnessAdapter = {
    adapterCapabilities: ["runtime-config"] as const,
    setModel() {},
    async applyConfig(config: Record<string, unknown>) {
      // What the real Pi driver refuses: the placeholder lives in a profile
      // file the running process reads, so only a projection that actually
      // changes is a rotation. Everything else applies mid-turn.
      const next = JSON.stringify(config.auth)
      if (turns > 0 && next !== projected) throw new Error("Cannot rotate Pi credentials during an active turn")
      if (refuseHeldApply && next !== projected) throw new Error("the profile could not be written")
      projected = next
      applied.push(config)
    },
    sessionConfigOwner: "runtime" as const,
    async createSession(_directory: string, title: string | undefined, id?: string) {
      const sessionId = id ?? "generated"
      upstream.set(sessionId, { id: sessionId, title, directory, time: { created: 10, updated: 10 } })
      return { id: sessionId, agentSessionId: `upstream-${sessionId}` }
    },
    async getSession() { return null },
    async getMessages() { return [] },
    async updateSession() { return null },
    async deleteSession() {},
    async getSessionConfig() { throw new Error("runtime-owned config") },
    async updateSessionConfig() { throw new Error("runtime-owned config") },
    readHarnessCapabilities: () => ({
      abort: false, reconnect: false, replay: true, permissions: false, questions: false,
      todos: false, commands: false, fork: false, revert: false, unrevert: false,
      configOptions: false, subagents: false, goals: false, harness: "pi",
    }),
    async *executeTurn(binding: { sessionId: string }) {
      turns++
      started()
      try {
        await heldTurn
        yield { type: "text-delta", delta: "answer" }
        yield { type: "finish", sessionId: binding.sessionId }
      } finally {
        turns--
      }
    },
    dispose() {},
  } as unknown as AgentHarnessAdapter

  const host = createWorkspaceHost({
    target,
    storeRoot: join(directory, "state"),
    harnesses: [{ match: (runner: { id: string }) => runner.id === "pi", create: () => adapter }],
  } as never)
  cleanups.push(() => host.dispose())
  const app = new Hono()
  host.mount(app, { exposure: loopbackWorkspaceRuntimeExposure() })
  const request = (pathname: string, method = "GET", body?: unknown) => withWorkspaceTarget(target, () => app.request(
    `http://runtime.test${pathname}?directory=${encodeURIComponent(directory)}`,
    { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) },
  ))
  return { host, request, applied, startedTurn, release, refuseHeld: () => { refuseHeldApply = true }, placeholders: () => [...new Set(applied.map((config) => (config.auth as Record<string, { placeholder?: string }>).pi?.placeholder))] }
}

test("a renewal pushed into a running native turn is held, not failed, and lands when the turn ends", async () => {
  const f = await fixture()
  await f.host.apply(snapshot("first"))
  expect(f.placeholders()).toEqual(["first"])
  expect((await f.request("/session", "POST", { id: "held" })).status).toBe(201)

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
  const mcp = { docs: { type: "local", command: ["docs"] } }
  await f.host.apply(snapshot("first", mcp))

  expect(f.host.detail().configApply?.state).toBe("applied")
  expect(f.applied.at(-1)!.mcp).toEqual(mcp)

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
  // and the adapter is asked to rotate while it is talking to the process.
  await expect(f.host.apply(snapshot("renewed", { docs: { type: "local", command: ["docs"] } }))).rejects.toThrow()
  expect(f.host.detail().configApply?.state).toBe("failed")

  f.release()
  await prompt
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

  expect(f.host.detail().configApply?.state).toBe("failed")
  expect(f.placeholders()).toEqual(["first"])
})
