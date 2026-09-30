/// <reference types="bun" />
import { expect, test } from "bun:test"
import { sessionEndpoint } from "./session-context"
import { NO_GOAL } from "./session-goal"
import { startSessionReads } from "./session-reads"
import { fakeServer, firstPath, firstRead, liveSession, openPath, openView, ref, shape } from "./test-session-server"

test("session reads: a running session opens with one first read for its row, outline and page, beside one read of its status, requests, todos, goal and subagents", async () => {
  const permission = { id: "per_1", sessionID: "ses_1", permission: "edit", patterns: [], metadata: {}, always: [] }
  const question = { id: "que_1", sessionID: "ses_1", questions: [] }
  const todo = { id: "todo_1", content: "Ship it", status: "pending", priority: "high" }
  const goal = { sessionId: "ses_1", objective: "Ship it", status: "active" as const, createdAt: 1, updatedAt: 2 }
  const server = fakeServer({
    reachable: () => true,
    machine: true,
    runtime: (path) => {
      if (path === firstPath) return firstRead()
      if (path === openPath) {
        return openView({
          status: { value: { type: "busy" } },
          permissions: { value: [permission] },
          questions: { value: [question] },
          todos: { value: [todo] },
          goal: { value: { capabilities: { implemented: true, available: true, actions: ["pause"] }, goal } },
          subagents: { value: [{ subagentKey: "sub_1", revision: 2, status: "running", toolCallEdges: [{ toolCallId: "call_1", role: "spawn", revision: 1 }] }] },
        })
      }
      return Response.json({ error: { message: `unexpected runtime read ${path}` } }, { status: 500 })
    },
  })
  const reads = startSessionReads(server.context, ref, shape)

  const first = await reads.first
  expect(first.row.title).toBe("Live title")
  expect(first.outline).toEqual({ turns: [{ id: "msg_1", createdAt: 1, preview: { user: "why?" } }], complete: true })
  expect(first.transcript.entries.map((entry) => entry.info.id)).toEqual(["msg_1", "msg_2"])
  expect(await reads.status).toEqual({ kind: "working" })
  expect((await reads.requests).map((request) => `${request.kind}:${request.id}`)).toEqual(["permission:per_1", "question:que_1"])
  expect(await reads.todos).toEqual([todo])
  expect(await reads.goal).toEqual({ goal, actions: ["pause"], available: true })
  expect((await reads.subagents).map((row) => [row.subagentKey, row.revision, row.toolCallId ?? null])).toEqual([["sub_1", 2, null], ["sub_1", 1, "call_1"]])
  expect([...server.runtimeCalls].sort()).toEqual([firstPath, openPath].sort())
})

test("session reads: a fact the runtime could not read fails alone, and a runtime with no goal reads as no goal", async () => {
  const server = fakeServer({
    reachable: () => true,
    machine: true,
    runtime: (path) => {
      if (path === firstPath) return firstRead()
      if (path === openPath) {
        return openView({
          questions: { error: { status: 502, code: "harness_engine_error", message: "The engine refused the question list" } },
          goal: { error: { status: 503, code: "goal_runtime_unavailable", message: "Goal runtime is unavailable" } },
        })
      }
      return Response.json({ error: { message: `unexpected runtime read ${path}` } }, { status: 500 })
    },
  })
  const reads = startSessionReads(server.context, ref, shape)

  expect((await reads.first).transcript.entries).toHaveLength(2)
  await expect(reads.requests).rejects.toMatchObject({ class: "network", status: 502, code: "harness_engine_error", message: "The engine refused the question list" })
  expect(await reads.todos).toEqual([])
  expect(await reads.goal).toEqual(NO_GOAL)
})

test("session status: a session whose last turn failed reads as failed once its runtime is idle", async () => {
  const failed = { ...liveSession, lastTurn: { status: "failed", error: "The provider refused", completedAt: 40 } }
  const server = fakeServer({
    reachable: () => true,
    machine: true,
    runtime: (path) => {
      if (path === firstPath) return firstRead(failed)
      if (path === openPath) return openView()
      return Response.json({ error: { message: `unexpected runtime read ${path}` } }, { status: 500 })
    },
  })

  expect(await startSessionReads(server.context, ref, shape).status).toMatchObject({ kind: "failed", error: { message: "The provider refused" } })
})

test("session status: settling a held idle reads the row and the open view, and the row's last turn names the failure", async () => {
  const server = fakeServer({
    reachable: () => true,
    machine: true,
    runtime: (path) => {
      if (path === sessionEndpoint(ref)) return Response.json({ ...liveSession, lastTurn: { status: "failed", error: "The provider refused", completedAt: 40 } })
      if (path === openPath) return openView()
      return Response.json({ error: { message: `unexpected runtime read ${path}` } }, { status: 500 })
    },
  })

  const status = await server.context.status.settle(await server.context.workspaces.route(ref), ref)

  expect(status).toMatchObject({ kind: "failed", error: { message: "The provider refused" } })
  expect([...server.runtimeCalls].sort()).toEqual([sessionEndpoint(ref), openPath].sort())
})

test("session reads: background work rides beside the turn's status in the open view, and a session without it reads none", async () => {
  const opened = (status: unknown) => fakeServer({
    reachable: () => true,
    machine: true,
    runtime: (path) => {
      if (path === firstPath) return firstRead()
      if (path === openPath) return openView({ status: { value: status } })
      return Response.json({ error: { message: `unexpected runtime read ${path}` } }, { status: 500 })
    },
  })
  const background = startSessionReads(opened({ type: "idle", backgroundWork: true }).context, ref, shape)
  expect(await background.status).toEqual({ kind: "idle" })
  expect(await background.backgroundWork).toBe(true)
  const turning = startSessionReads(opened({ type: "busy", backgroundWork: true }).context, ref, shape)
  expect(await turning.status).toEqual({ kind: "working" })
  expect(await turning.backgroundWork).toBe(true)
  const quiet = startSessionReads(opened(null).context, ref, shape)
  expect(await quiet.backgroundWork).toBe(false)
})
