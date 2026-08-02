import { describe, expect, it } from "vitest"
import BetterSqlite3 from "better-sqlite3"
import { createSqliteSessionIntakePort } from "@claxedo/workgraph"
import { readIdleSession, subscribeSessionIntake } from "./session-intake"

describe("WorkGraph Session intake host", () => {
  it("projects a meaningful idle Session once into durable unorganized intake", async () => {
    const database = new BetterSqlite3(":memory:")
    const listeners: Array<(event: any) => unknown> = []
    try {
      const request = async (input: Request) => input.url.includes("/message")
        ? Response.json([
            { info: { role: "user" }, parts: [{ type: "text", text: "Plan the launch" }] },
            { info: { role: "assistant" }, parts: [{ type: "text", text: "We need staging, billing, and docs." }] },
          ])
        : Response.json({ id: "session-1", title: "Launch planning" })
      const unsubscribe = subscribeSessionIntake({
        events: { subscribe: (listener) => (listeners.push(listener), () => undefined) },
        opencodeRequest: request,
        port: createSqliteSessionIntakePort(database),
        directory: "/repo",
        resolveContext: () => context(),
      })
      const idle = { directory: "/repo", payload: { type: "session.status", properties: { sessionID: "session-1", status: { type: "idle" } } } }
      listeners[0]!(idle)
      listeners[0]!(idle)
      await eventually(() => {
        expect(database.prepare("SELECT title, body, status FROM wg_v2_intake_candidates").all()).toEqual([{
          title: "Launch planning",
          body: "We need staging, billing, and docs.",
          status: "unorganized",
        }])
      })
      unsubscribe()
    } finally {
      database.close()
    }
  })

  it("ignores WorkGraph-owned execution Sessions and non-meaningful idle Sessions", async () => {
    const listeners: Array<(event: any) => unknown> = []
    let reads = 0
    subscribeSessionIntake({
      events: { subscribe: (listener) => (listeners.push(listener), () => undefined) },
      opencodeRequest: async () => (reads++, Response.json({})),
      port: { createUnorganized: async () => "created" },
      directory: "/repo",
      resolveContext: () => context(),
    })
    listeners[0]!({ payload: { type: "session.status", properties: { sessionID: "ses_workgraph_run", status: { type: "idle" } } } })
    expect(reads).toBe(0)
  })

  it("reads real Session and message response shapes", async () => {
    const session = await readIdleSession(async (input) => input.url.includes("/message")
      ? Response.json([{ info: { role: "user" }, parts: [{ type: "text", text: "Question" }] }, { info: { role: "assistant" }, parts: [{ type: "text", text: "Answer" }] }])
      : Response.json({ title: "Title" }), "session", "/repo")
    expect(session).toMatchObject({ sessionId: "session", title: "Title", summary: "Answer", meaningful: true })
  })

  it("rejects a missing Session directory before reading Session APIs", async () => {
    let reads = 0
    await expect(readIdleSession(async () => (reads++, Response.json({})), "session", " "))
      .rejects.toMatchObject({ code: "session_intake_directory_required", retryable: false })
    expect(reads).toBe(0)
  })

  it("reports an idle event without its exact Session directory before reading Session APIs", () => {
    const listeners: Array<(event: any) => unknown> = []
    const errors: unknown[] = []
    let reads = 0
    subscribeSessionIntake({
      events: { subscribe: (listener) => (listeners.push(listener), () => undefined) },
      opencodeRequest: async () => (reads++, Response.json({})),
      port: { createUnorganized: async () => "created" },
      resolveContext: () => context(),
      onError: (error) => errors.push(error),
    })
    listeners[0]!({ payload: { type: "session.status", properties: { sessionID: "session-missing-dir", status: { type: "idle" } } } })
    expect(errors).toEqual([expect.objectContaining({ code: "session_intake_directory_required" })])
    expect(reads).toBe(0)
  })
})

function context() {
  return { organizationId: "local-org" as never, ownerUserId: "local" as never, actor: { type: "system" as const, id: "session_intake" as never }, requestId: "intake" as never, access: { mode: "owner" as const } }
}

async function eventually(assertion: () => void) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      assertion()
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
  assertion()
}
