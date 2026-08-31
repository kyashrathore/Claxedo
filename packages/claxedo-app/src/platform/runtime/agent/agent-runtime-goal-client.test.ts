import { describe, expect, test } from "bun:test"
import { createAgentRuntimeGoalClient } from "./agent-runtime-goal-client"

function clientReturning(response: () => Response) {
  const calls: Array<{ suffix?: string; method?: string }> = []
  const client = createAgentRuntimeGoalClient(async (input) => {
    calls.push({ suffix: input.suffix, method: input.init?.method })
    return response()
  })
  return { client, calls }
}

const request = { directory: "/repo/main", sessionID: "ses_1" }

describe("agent runtime goal client", () => {
  test("decodes the typed conflict body the runtime serializes with HTTP 409", async () => {
    const { client, calls } = clientReturning(() =>
      Response.json({ ok: false, status: "conflict", message: "A Goal is already active" }, { status: 409 }),
    )

    await expect(client.startGoal({ ...request, objective: "Ship it" })).resolves.toEqual({
      ok: false,
      status: "conflict",
      message: "A Goal is already active",
    })
    expect(calls).toEqual([{ suffix: "/goal", method: "POST" }])
  })

  test("decodes the typed not_found body the runtime serializes with HTTP 404", async () => {
    const { client } = clientReturning(() =>
      Response.json({ ok: false, status: "not_found", message: "No Goal for this session" }, { status: 404 }),
    )

    await expect(client.stopGoal(request)).resolves.toEqual({
      ok: false,
      status: "not_found",
      message: "No Goal for this session",
    })
  })

  test("decodes the typed failed body the runtime serializes with HTTP 502", async () => {
    const { client } = clientReturning(() =>
      Response.json({ ok: false, status: "failed", message: "provider refused" }, { status: 502 }),
    )

    await expect(client.deleteGoal(request)).resolves.toEqual({
      ok: false,
      status: "failed",
      message: "provider refused",
    })
  })

  test("throws for a runtime error body that is not a typed mutation result", async () => {
    const { client } = clientReturning(() =>
      Response.json({ error: { code: "goal_session_not_found", message: "Session is gone" } }, { status: 404 }),
    )

    await expect(client.pauseGoal(request)).rejects.toThrow(/goal_session_not_found/)
  })

  test("throws for an unexpected transport status", async () => {
    const { client } = clientReturning(() => new Response("gateway down", { status: 503 }))

    await expect(client.resumeGoal(request)).rejects.toThrow("gateway down")
  })

  test("still returns the success body", async () => {
    const goal = { sessionId: "ses_1", objective: "Ship it", status: "active", createdAt: 1, updatedAt: 2 }
    const { client } = clientReturning(() => Response.json({ ok: true, goal }))

    await expect(client.startGoal({ ...request, objective: "Ship it" })).resolves.toEqual({ ok: true, goal })
  })

  test("reads keep throwing on any non-2xx", async () => {
    const { client } = clientReturning(() => new Response("nope", { status: 409 }))

    await expect(client.getGoal(request)).rejects.toThrow("nope")
    await expect(client.getGoalCapabilities(request)).rejects.toThrow("nope")
  })
})
