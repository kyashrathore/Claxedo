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

function snapshot(placeholder: string, mcp: Record<string, unknown> = {}): RuntimeSnapshot {
  return {
    version: 4,
    mcp,
    connections: [],
    defaultHarness: { kind: "native", harnessId: "pi" },
    auth: {
      pi: {
        baseUrl: "http://127.0.0.1:2595/bindings/pi1",
        placeholder,
        authMode: "bearer",
        expiresAt: Date.now() + 60 * 60 * 1000,
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
  let turns = 0
  let started = () => {}
  const startedTurn = new Promise<void>((resolve) => { started = resolve })
  let release = () => {}
  const heldTurn = new Promise<void>((resolve) => { release = resolve })

  const adapter: AgentHarnessAdapter = {
    adapterCapabilities: ["runtime-config"] as const,
    setModel() {},
    async applyConfig(config: Record<string, unknown>) {
      if (turns > 0) throw new Error("Cannot rotate Pi credentials during an active turn")
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
  return { host, request, applied, startedTurn, release, placeholders: () => [...new Set(applied.map((config) => (config.auth as Record<string, { placeholder?: string }>).pi?.placeholder))] }
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
  await expect(f.host.apply(snapshot("first", { docs: { type: "local", command: ["docs"] } }))).rejects.toThrow()
  expect(f.host.detail().configApply?.state).toBe("failed")

  f.release()
  await prompt
})
