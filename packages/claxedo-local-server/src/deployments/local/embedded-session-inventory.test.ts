import { afterEach, expect, test } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { disposeAgentConfig } from "@claxedo/server-core/agent-config/index"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import type { Workspace } from "@claxedo/server-core/workspace/store/index"
import {
  configureEmbeddedWorkspaceRuntime,
  embeddedWorkspaceRuntimeGeneration,
  embeddedWorkspaceRuntimeOwners,
  ensureEmbeddedWorkspaceRuntime,
  readMountedEmbeddedWorkspaceRuntimeAttention,
  readMountedEmbeddedWorkspaceRuntimeRemoved,
  releaseEmbeddedWorkspaceRuntime,
  shutdownEmbeddedWorkspaceRuntimes,
} from "./embedded-workspace-runtime"

const previousDataDir = process.env.CLAXEDO_DATA_DIR
const roots: string[] = []

afterEach(async () => {
  await shutdownEmbeddedWorkspaceRuntimes()
  disposeAgentConfig()
  ClaxedoDB.close()
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previousDataDir
})

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "embedded-session-inventory-"))
  roots.push(root)
  process.env.CLAXEDO_DATA_DIR = path.join(root, "data")
  configureEmbeddedWorkspaceRuntime({ sessionIdWorkspace: () => undefined })
  async function workspace(id: string): Promise<Workspace> {
    const directory = path.join(root, id)
    await fs.mkdir(directory)
    return { id, directory, kind: "local", created_at: 1, updated_at: 1 }
  }
  return { workspace }
}

test("mounted canonical root tombstones survive restart without opening a browser or session", async () => {
  const { workspace } = await fixture()
  const ws = await workspace("ws_restart")
  expect(readMountedEmbeddedWorkspaceRuntimeRemoved(ws.id)).toBeUndefined()
  expect(embeddedWorkspaceRuntimeGeneration(ws.id)).toBeUndefined()
  expect(embeddedWorkspaceRuntimeOwners()).toEqual([])

  const first = await ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" })
  const generation = embeddedWorkspaceRuntimeGeneration(ws.id)
  expect(generation).toBe(first.host.ownerGeneration)
  const store = first.host.store()
  store.bindSession({ sessionId: "root", workspaceId: ws.id, directory: ws.directory, connectionId: "native", upstreamSessionId: "root-up", agentSessionId: "root-up", owner: { kind: "machine-owner" } })
  store.bindSession({ sessionId: "child", workspaceId: ws.id, directory: ws.directory, connectionId: "native", upstreamSessionId: "child-up", agentSessionId: "child-up", parentSessionId: "root", owner: { kind: "machine-owner" } })
  // A later bind must retain the child's ancestry in the authoritative journal.
  store.bindSession({ sessionId: "child", directory: ws.directory, agentSessionId: "child-up" })
  store.deleteSession("root")
  expect(store.getSession("child")).toBeNull()
  expect(readMountedEmbeddedWorkspaceRuntimeRemoved(ws.id)).toEqual(["root"])

  await releaseEmbeddedWorkspaceRuntime(ws.id)
  expect(readMountedEmbeddedWorkspaceRuntimeRemoved(ws.id)).toBeUndefined()
  expect(embeddedWorkspaceRuntimeGeneration(ws.id)).toBeUndefined()
  // Source resync can prepare the store directly; no content stream or harness is opened.
  const restarted = await ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" })
  expect(embeddedWorkspaceRuntimeGeneration(ws.id)).toBe(restarted.host.ownerGeneration)
  expect(embeddedWorkspaceRuntimeGeneration(ws.id)).not.toBe(generation)
  expect(readMountedEmbeddedWorkspaceRuntimeRemoved(ws.id)).toEqual(["root"])
  expect(restarted.host.store().getSession("child")).toBeNull()
  expect(restarted.host.activeTurns()).toEqual([])
  expect(await restarted.host.unresolvedLaunches()).toEqual([])
})

test("mounted removal inventory includes neither child tombstones nor another workspace", async () => {
  const { workspace } = await fixture()
  const ws = await workspace("ws_one")
  const other = await workspace("ws_two")
  const mounted = await ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" })
  const elsewhere = await ensureEmbeddedWorkspaceRuntime(other, { config: "skip" })
  mounted.host.store().bindSession({ sessionId: "root", workspaceId: ws.id, directory: ws.directory, connectionId: "native", upstreamSessionId: "up", agentSessionId: "up", owner: { kind: "machine-owner" } })
  mounted.host.store().bindSession({ sessionId: "child", workspaceId: ws.id, directory: ws.directory, connectionId: "native", upstreamSessionId: "child-up", agentSessionId: "child-up", parentSessionId: "root", owner: { kind: "machine-owner" } })
  mounted.host.store().deleteSession("child")
  elsewhere.host.store().bindSession({ sessionId: "other-root", workspaceId: other.id, directory: other.directory, connectionId: "native", upstreamSessionId: "other-up", agentSessionId: "other-up", owner: { kind: "machine-owner" } })
  elsewhere.host.store().deleteSession("other-root")
  expect(readMountedEmbeddedWorkspaceRuntimeRemoved(ws.id)).toEqual([])
  expect(readMountedEmbeddedWorkspaceRuntimeRemoved(other.id)).toEqual(["other-root"])
  expect(readMountedEmbeddedWorkspaceRuntimeRemoved("unmounted")).toBeUndefined()
})

test("mounted root attention snapshots read exact journal facts synchronously and preserve scope", async () => {
  const { workspace } = await fixture()
  const ws = await workspace("ws_attention")
  const other = await workspace("ws_attention_other")
  expect(readMountedEmbeddedWorkspaceRuntimeAttention(ws.id)).toBeUndefined()
  const mounted = await ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" })
  const elsewhere = await ensureEmbeddedWorkspaceRuntime(other, { config: "skip" })
  const store = mounted.host.store()
  store.bindSession({ sessionId: "root", workspaceId: ws.id, directory: ws.directory, connectionId: "native", upstreamSessionId: "up", agentSessionId: "up", owner: { kind: "machine-owner" } })
  store.bindSession({ sessionId: "child", workspaceId: ws.id, directory: ws.directory, connectionId: "native", upstreamSessionId: "child-up", agentSessionId: "child-up", parentSessionId: "root", owner: { kind: "machine-owner" } })
  elsewhere.host.store().bindSession({ sessionId: "other", workspaceId: other.id, directory: other.directory, connectionId: "native", upstreamSessionId: "other-up", agentSessionId: "other-up", owner: { kind: "machine-owner" } })
  const baseline = readMountedEmbeddedWorkspaceRuntimeAttention(ws.id)!
  expect(baseline).toEqual([{ sessionId: "root", attention: store.getSession("root")!.attention }])
  store.startTurn({ sessionId: "root", agentSessionId: "up", userMessageId: "prompt", assistantMessageId: "answer", agent: "build", parts: [] })
  const live = readMountedEmbeddedWorkspaceRuntimeAttention(ws.id, "root")!
  expect(live).toEqual([{ sessionId: "root", attention: store.getSession("root")!.attention }])
  expect(readMountedEmbeddedWorkspaceRuntimeAttention(ws.id, "child")).toEqual([])
  expect(readMountedEmbeddedWorkspaceRuntimeAttention(ws.id, "other")).toEqual([])
  expect(readMountedEmbeddedWorkspaceRuntimeAttention(other.id)!.map((row) => row.sessionId)).toEqual(["other"])
  await releaseEmbeddedWorkspaceRuntime(ws.id)
  expect(readMountedEmbeddedWorkspaceRuntimeAttention(ws.id)).toBeUndefined()
})
