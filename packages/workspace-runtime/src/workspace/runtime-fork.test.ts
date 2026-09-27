import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import type { AgentExecutionBinding } from "@claxedo/agent-runtime-contract"
import type { AgentHarnessAdapter } from "@claxedo/agent-sdk-runtime/adapters"
import { withWorkspaceTarget } from "../target"
import { loopbackWorkspaceRuntimeExposure } from "../exposure"
import { createWorkspaceHost } from "./runtime"
import type { RuntimeSnapshot } from "../routes/config"

const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const snapshot: RuntimeSnapshot = {
  version: 4,
  mcp: {},
  connections: [],
  defaultHarness: { kind: "native", harnessId: "pi" },
  harnessLaunch: { pi: { agentDir: "/profiles/pi" } },
  auth: {
    pi: {
      baseUrl: "http://127.0.0.1:2595/bindings/pi1",
      placeholder: "placeholder",
      authMode: "bearer",
      expiresAt: Date.now() + 60 * 60 * 1000,
    },
  },
}

/**
 * A harness that keeps its sessions in its own engine, as OpenCode does: it
 * writes nothing into the host's store, so a session exists for the runtime
 * only once the host has persisted it.
 */
async function fixture(fork: (childId?: string) => string) {
  const directory = await mkdtemp(join(tmpdir(), "runtime-fork-"))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const target = { workspaceId: "ws_fork", directory }
  const forks: Array<{ parentId: string; messageId: string; childId?: string }> = []
  const deleted: string[] = []
  const adapter = {
    adapterCapabilities: ["runtime-config"] as const,
    setModel() {},
    async applyConfig() {},
    sessionConfigOwner: "runtime" as const,
    async createSession(_directory: string, _title: string | undefined, id?: string) {
      return { id: id ?? "generated" }
    },
    async forkSession(binding: AgentExecutionBinding, messageId: string, childId?: string) {
      forks.push({ parentId: binding.sessionId, messageId, ...(childId ? { childId } : {}) })
      return { id: fork(childId) }
    },
    async getSession() { return null },
    async getMessages() { return [] },
    async updateSession() { return null },
    async deleteSession(binding: AgentExecutionBinding) { deleted.push(binding.sessionId) },
    async getSessionConfig() { throw new Error("runtime-owned config") },
    async updateSessionConfig() { throw new Error("runtime-owned config") },
    readHarnessCapabilities: () => ({
      abort: false, reconnect: false, replay: true, permissions: false, questions: false,
      todos: false, commands: false, fork: true, revert: false, unrevert: false,
      configOptions: false, subagents: false, goals: false, harness: "pi",
    }),
    async *executeTurn() {},
    dispose() {},
  } as unknown as AgentHarnessAdapter
  const host = createWorkspaceHost({
    target,
    storeRoot: join(directory, "state"),
    harnesses: [{ match: (runner: { id: string }) => runner.id === "pi", create: () => adapter }],
  } as never)
  cleanups.push(() => host.dispose())
  await host.apply(snapshot)
  const app = new Hono()
  host.mount(app, { exposure: loopbackWorkspaceRuntimeExposure() })
  const request = (pathname: string, method = "GET", body?: unknown) => withWorkspaceTarget(target, () => app.request(
    `http://runtime.test${pathname}?directory=${encodeURIComponent(directory)}`,
    { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) },
  ))
  expect((await request("/session", "POST", { id: "parent" })).status).toBe(201)
  return { request, forks, deleted }
}

test("a fork by a harness that keeps its sessions elsewhere is persisted by the host, then read back under the requested id", async () => {
  const f = await fixture((childId) => childId ?? "engine_child")

  const response = await f.request("/session/parent/fork", "POST", { id: "child", messageId: "msg_1" })

  expect(response.status).toBe(201)
  const forked = await response.json() as { id: string; time: { created: number; updated: number } }
  expect(forked.id).toBe("child")
  expect(forked.time.updated).toBeGreaterThanOrEqual(forked.time.created)
  expect(f.forks).toEqual([{ parentId: "parent", messageId: "msg_1", childId: "child" }])
  const read = await f.request("/session/child")
  expect(read.status).toBe(200)
  expect(await read.json()).toMatchObject({ id: "child", time: forked.time })
})
