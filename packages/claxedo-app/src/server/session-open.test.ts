/// <reference types="bun" />
import { expect, test } from "bun:test"
import { sessionEndpoint } from "./session-context"
import { NO_GOAL } from "./session-goal"
import { readSession } from "./session-reads"
import { fakeServer, historyPath, liveSession, openPath, openView, ref, stored } from "./test-session-server"

const outlinePath = sessionEndpoint(ref, "/outline")

test("session reads: one runtime read opens a running session's row, status, requests, todos, goal and subagents beside its history", async () => {
  const permission = { id: "per_1", sessionID: "ses_1", permission: "edit", patterns: [], metadata: {}, always: [] }
  const question = { id: "que_1", sessionID: "ses_1", questions: [] }
  const todo = { id: "todo_1", content: "Ship it", status: "pending", priority: "high" }
  const goal = { sessionId: "ses_1", objective: "Ship it", status: "active" as const, createdAt: 1, updatedAt: 2 }
  const server = fakeServer({
    reachable: () => true,
    machine: true,
    runtime: (path) => {
      if (path === historyPath) return Response.json(stored)
      if (path === outlinePath) return Response.json({ turns: [], complete: true })
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
  const reads = readSession(server.context, ref)

  expect((await reads.surface).row.title).toBe("Live title")
  expect(await reads.status).toEqual({ kind: "working" })
  expect((await reads.requests).map((request) => `${request.kind}:${request.id}`)).toEqual(["permission:per_1", "question:que_1"])
  expect(await reads.todos).toEqual([todo])
  expect(await reads.goal).toEqual({ goal, actions: ["pause"], available: true })
  expect((await reads.subagents).map((row) => [row.subagentKey, row.revision, row.toolCallId ?? null])).toEqual([["sub_1", 2, null], ["sub_1", 1, "call_1"]])
  expect([...server.runtimeCalls].sort()).toEqual([historyPath, openPath, outlinePath].sort())
})

for (const refused of ["permissions", "questions"] as const) {
  test(`session reads: refused ${refused} fail the requests alone, and a runtime with no goal reads as no goal`, async () => {
    const server = fakeServer({
      reachable: () => true,
      machine: true,
      runtime: (path) => {
        if (path === historyPath) return Response.json(stored)
        if (path === outlinePath) return Response.json({ turns: [], complete: true })
        if (path === openPath) {
          return openView({
            [refused]: { error: { status: 502, code: "harness_engine_error", message: `The engine refused the ${refused}` } },
            goal: { error: { status: 503, code: "goal_runtime_unavailable", message: "Goal runtime is unavailable" } },
          })
        }
        return Response.json({ error: { message: `unexpected runtime read ${path}` } }, { status: 500 })
      },
    })
    const reads = readSession(server.context, ref)

    expect((await reads.surface).transcript.entries).toHaveLength(2)
    await expect(reads.requests).rejects.toMatchObject({ class: "network", status: 502, code: "harness_engine_error", message: `The engine refused the ${refused}` })
    expect(await reads.todos).toEqual([])
    expect(await reads.goal).toEqual(NO_GOAL)
  })
}

test("session status: settling a held idle is one read of the open view, whose last turn names the failure", async () => {
  const server = fakeServer({
    reachable: () => true,
    machine: true,
    runtime: (path) => path === openPath
      ? openView({ session: { ...liveSession, lastTurn: { status: "failed", error: "The provider refused", completedAt: 40 } } })
      : Response.json({ error: { message: `unexpected runtime read ${path}` } }, { status: 500 }),
  })

  const status = await server.context.status.settle(await server.context.workspaces.route(ref), ref)

  expect(status).toMatchObject({ kind: "failed", error: { message: "The provider refused" } })
  expect(server.runtimeCalls).toEqual([openPath])
})
