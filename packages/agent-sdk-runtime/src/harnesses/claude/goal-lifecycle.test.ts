import { describe, expect, test } from "bun:test"
import type { Query } from "@anthropic-ai/claude-agent-sdk"
import { createSessionTurnLifecycle } from "../shared/turn-lifecycle"
import type { SdkRuntimeTurnInput } from "../shared/sdk-runtime-adapter"
import { nativeGoalCommand } from "../shared/native-goal-store"
import {
  claudeGoalSnapshot,
  claudeTranscriptGoalSnapshot,
  createClaudeSdkDriver,
  type ClaudeSdkDriverOptions,
} from "./driver"

function goalDriver(
  options: ClaudeSdkDriverOptions,
  onPublish: (goal: unknown) => void = () => {},
  lifecycle = createSessionTurnLifecycle(),
) {
  return createClaudeSdkDriver({
    lifecycle: () => lifecycle as never,
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    bindSession() {},
    getAgentSessionId: () => "claude-session",
    getSessionForAgentSession: () => null,
    getGoal: () => null,
    updatePermissionState() {},
    getSessionConfig: () => null,
    publishGoal(input) {
      onPublish(input.goal)
    },
    async runProviderTurn() { return true },
  }, { executable: () => "/fake/claude", ...options })
}

function goalTurnInput() {
  return {
    sessionId: "session-1",
    getAgentSessionId: () => "claude-session",
    getSessionForAgentSession: () => null,
    input: {
      parts: [{ type: "text", text: "Ship when checks pass" }],
      userMessageId: "user-1",
      assistantMessageId: "assistant-1",
      agent: "build",
      model: { providerID: "claude", modelID: "sonnet" },
    },
    directory: "/repo",
    abort: new AbortController(),
    ingest() {},
    associateChild() {},
    observeSubagent: async () => ({ event: {} }),
    rebindAgentSession() {},
    model: "sonnet",
  } as unknown as SdkRuntimeTurnInput
}

describe("Claude native Goal lifecycle", () => {
  test("drains cancellation before clearing the native hook and rejects late Goal updates", async () => {
    const lifecycle = createSessionTurnLifecycle()
    const input = goalTurnInput()
    const release = lifecycle.enter(input.sessionId)!
    const order: string[] = []
    let ready!: () => void
    const started = new Promise<void>((resolve) => { ready = resolve })
    const driver = goalDriver({ query: ((request: any) => {
      const stream = (async function* () {
        if (request.prompt === "/goal clear") {
          expect(lifecycle.busySessions.has(input.sessionId)).toBe(false)
          order.push("clear")
          yield { type: "result", subtype: "success", is_error: false, num_turns: 0 }
          return
        }
        await request.options.sessionStore.append({}, [{ type: "attachment", attachment: {
          type: "goal_status", met: false, condition: "Wait for my answer",
        } }])
        ready()
        await new Promise<void>((resolve) => input.abort.signal.addEventListener("abort", () => resolve(), { once: true }))
        order.push("aborted")
        await request.options.sessionStore.append({}, [{ type: "attachment", attachment: { type: "goal_status", met: true } }])
        yield { type: "active_goal", value: null }
      })()
      return Object.assign(stream, { close() {} }) as unknown as Query
    }) as never }, () => {}, lifecycle)
    const run = driver.nativeGoal!.run(input, "Wait for my answer", () => {}).finally(() => {
      order.push("idle")
      lifecycle.delete(input.sessionId)
      release()
    })
    await started
    expect(await driver.nativeGoal!.stop(input.sessionId, input.directory)).toMatchObject({ status: "paused", objective: "Wait for my answer" })
    await run
    expect(order).toEqual(["aborted", "idle", "clear"])
    expect(await driver.nativeGoal!.read(input.sessionId, input.directory)).toMatchObject({ status: "paused" })
  })

  test("does not accept a model response as confirmation that the native hook was cleared", async () => {
    const driver = goalDriver({ query: ((request: any) => {
      const stream = (async function* () {
        if (request.prompt === "/goal clear") {
          yield { type: "result", subtype: "success", is_error: false, num_turns: 1 }
          return
        }
        await request.options.sessionStore.append({}, [{ type: "attachment", attachment: {
          type: "goal_status", met: false, condition: "Wait for my answer",
        } }])
      })()
      return Object.assign(stream, { close() {} }) as unknown as Query
    }) as never })
    await driver.nativeGoal!.run(goalTurnInput(), "Wait for my answer", () => {})
    await expect(driver.nativeGoal!.stop("session-1", "/repo")).rejects.toThrow("did not confirm")
    expect(await driver.nativeGoal!.read("session-1", "/repo")).toMatchObject({
      status: "blocked", lastReason: "Claude did not confirm clearing the native Goal",
    })
  })

  test("sends /goal through query and accepts the CLI transcript Goal authority", async () => {
    const calls: unknown[] = []
    const published: unknown[] = []
    const fakeQuery = ((input: {
      prompt: string
      options: {
        sessionStore: { append(key: { projectKey: string; sessionId: string }, entries: unknown[]): Promise<void> }
      }
    }) => {
      calls.push(input)
      const stream = (async function* () {
        if (input.prompt === "/goal clear") {
          yield { type: "result", subtype: "success", is_error: false, num_turns: 0 }
          return
        }
        await input.options.sessionStore.append(
          { projectKey: "/repo", sessionId: "claude-session" },
          [{
            type: "attachment",
            timestamp: "2023-11-14T22:13:20.000Z",
            attachment: {
              type: "goal_status",
              met: false,
              condition: "Ship when checks pass",
              reason: "One test remains",
            },
          }],
        )
      })()
      return Object.assign(stream, { close() {} }) as unknown as Query
    }) as never
    const driver = goalDriver({ query: fakeQuery }, (goal) => published.push(goal))
    const observed: unknown[] = []

    await driver.nativeGoal!.run(goalTurnInput(), "Ship when checks pass", (goal) => observed.push(goal))

    expect(nativeGoalCommand("Ship when checks pass")).toBe("/goal Ship when checks pass")
    expect(calls).toMatchObject([{
      prompt: "/goal Ship when checks pass",
      options: { cwd: "/repo", resume: "claude-session" },
    }])
    expect(observed).toEqual([{
      sessionId: "session-1",
      objective: "Ship when checks pass",
      status: "active",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      lastReason: "One test remains",
    }])
    expect(published).toEqual(observed)
    expect(await driver.nativeGoal!.stop("session-1", "/repo")).toMatchObject({
      objective: "Ship when checks pass",
      status: "paused",
    })
    expect(calls).toMatchObject([
      { prompt: "/goal Ship when checks pass" },
      { prompt: "/goal clear", options: { resume: "claude-session", cwd: "/repo", tools: [] } },
    ])
    // Delete is added by the resource, after stop has cleared the native hook.
    expect(await driver.nativeGoal!.capabilities("session-1", "/repo")).toMatchObject({
      actions: [],
    })
    expect(await driver.nativeGoal!.read("session-1", "/repo")).toMatchObject({ status: "paused" })
  })

  test("clears the Goal when an ordinary turn after /goal reports it met", async () => {
    const published: unknown[] = []
    const fakeQuery = ((input: {
      prompt: unknown
      options: {
        sessionStore: { append(key: { projectKey: string; sessionId: string }, entries: unknown[]): Promise<void> }
      }
    }) => {
      const goalTurn = typeof input.prompt === "string" && input.prompt.startsWith("/goal ")
      const stream = (async function* () {
        await input.options.sessionStore.append({ projectKey: "/repo", sessionId: "claude-session" }, [{
          type: "attachment",
          timestamp: "2023-11-14T22:13:20.000Z",
          attachment: { type: "goal_status", met: !goalTurn, condition: "Ship when checks pass" },
        }])
        if (!goalTurn) yield { type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: "claude-session" }
      })()
      return Object.assign(stream, { close() {} }) as unknown as Query
    }) as never
    const driver = goalDriver({ query: fakeQuery }, (goal) => published.push(goal))

    await driver.nativeGoal!.run(goalTurnInput(), "Ship when checks pass", () => {})
    await driver.runTurn(goalTurnInput())

    // The Stop hook the /goal turn installed keeps the Goal alive across later
    // turns, so the turn that meets it is usually not the /goal turn.
    expect(published).toMatchObject([{ objective: "Ship when checks pass", status: "active" }, null])
    expect(await driver.nativeGoal!.read("session-1", "/repo")).toBeNull()
  })

  test("hands every Goal turn an empty mirror so the CLI resumes from its own transcript", async () => {
    const atSpawn: unknown[] = []
    const fakeQuery = ((input: {
      options: {
        sessionStore: {
          append(key: { projectKey: string; sessionId: string }, entries: unknown[]): Promise<void>
          load(key: { projectKey: string; sessionId: string }): Promise<unknown[] | null>
        }
      }
    }) => {
      const key = { projectKey: "/repo", sessionId: "claude-session" }
      const store = input.options.sessionStore
      const stream = (async function* () {
        // The SDK loads the store once, in the parent, BEFORE spawning: a
        // non-empty answer is materialized into a temporary CLAUDE_CONFIG_DIR
        // the CLI is resumed from instead of its own transcript.
        atSpawn.push(await store.load(key))
        await store.append(key, [{
          type: "attachment",
          timestamp: "2023-11-14T22:13:20.000Z",
          attachment: { type: "goal_status", met: false, condition: "Ship when checks pass" },
        }])
      })()
      return Object.assign(stream, { close() {} }) as unknown as Query
    }) as never
    const driver = goalDriver({ query: fakeQuery })
    const observed: unknown[] = []
    const input = goalTurnInput()

    await driver.nativeGoal!.run(input, "Ship when checks pass", (goal) => observed.push(goal))
    await driver.nativeGoal!.run(input, "Ship when checks pass", (goal) => observed.push(goal))

    // Never seeded, and never carried over: the previous turn's entries must
    // not become the transcript the next resume is built from.
    expect(atSpawn.map((entries) => (entries as unknown[] | null)?.length ?? 0)).toEqual([0, 0])
    // The appends still arrive, which is the whole reason the mirror exists.
    expect(observed).toMatchObject([
      { objective: "Ship when checks pass", status: "active" },
      { objective: "Ship when checks pass", status: "active" },
    ])
  })

  test("keeps a malformed transcript entry out of the SDK append path", async () => {
    const observed: unknown[] = []
    const fakeQuery = ((input: {
      options: {
        sessionStore: { append(key: { projectKey: string; sessionId: string }, entries: unknown[]): Promise<void> }
      }
    }) => {
      const stream = (async function* () {
        await input.options.sessionStore.append({ projectKey: "/repo", sessionId: "claude-session" }, [
          null,
          { type: "attachment", attachment: "goal_status" },
          { type: "attachment", attachment: { type: "goal_status", met: false } },
          { type: "attachment", attachment: { type: "goal_status", met: "no", condition: "Ship" } },
          {
            type: "attachment",
            timestamp: "2023-11-14T22:13:20.000Z",
            attachment: { type: "goal_status", met: false, condition: "Ship when checks pass" },
          },
        ])
      })()
      return Object.assign(stream, { close() {} }) as unknown as Query
    }) as never
    const driver = goalDriver({ query: fakeQuery })

    await driver.nativeGoal!.run(goalTurnInput(), "Ship when checks pass", (goal) => observed.push(goal))

    expect(observed).toMatchObject([{ objective: "Ship when checks pass", status: "active" }])
  })

  test("settles the Goal as blocked when the Goal query dies instead of leaving it active", async () => {
    const observed: unknown[] = []
    const published: unknown[] = []
    const fakeQuery = ((input: {
      options: {
        sessionStore: { append(key: { projectKey: string; sessionId: string }, entries: unknown[]): Promise<void> }
      }
    }) => {
      const stream = (async function* () {
        await input.options.sessionStore.append({ projectKey: "/repo", sessionId: "claude-session" }, [{
          type: "attachment",
          timestamp: "2023-11-14T22:13:20.000Z",
          attachment: { type: "goal_status", met: false, condition: "Ship when checks pass" },
        }])
        throw new Error("claude process exited")
      })()
      return Object.assign(stream, { close() {} }) as unknown as Query
    }) as never
    const driver = goalDriver({ query: fakeQuery }, (goal) => published.push(goal))

    await expect(driver.nativeGoal!.run(goalTurnInput(), "Ship when checks pass", (goal) => observed.push(goal)))
      .rejects.toThrow("claude process exited")

    expect(observed).toMatchObject([
      { status: "active" },
      { status: "blocked", lastReason: "claude process exited" },
    ])
    expect(published).toEqual(observed)
    expect(await driver.nativeGoal!.read("session-1", "/repo")).toMatchObject({ status: "blocked" })
  })

  test("normalizes provider clear without manufacturing a snapshot", () => {
    expect(claudeGoalSnapshot("session-1", {
      type: "active_goal",
      value: null,
      uuid: "00000000-0000-0000-0000-000000000002",
      session_id: "claude-session",
    })).toBeNull()
    expect(claudeTranscriptGoalSnapshot("session-1", {
      type: "attachment",
      attachment: { type: "goal_status", met: true, condition: "Ship" },
    })).toBeNull()
    expect(claudeTranscriptGoalSnapshot("session-1", {
      type: "attachment",
      attachment: { type: "other" },
    })).toBeUndefined()
    // Reading an untyped attachment must degrade, never throw: this runs inside
    // the SDK's `sessionStore.append`, where a throw fails the Goal turn.
    expect(claudeTranscriptGoalSnapshot("session-1", null as never)).toBeUndefined()
    expect(claudeTranscriptGoalSnapshot("session-1", "goal_status" as never)).toBeUndefined()
    expect(claudeTranscriptGoalSnapshot("session-1", {
      type: "attachment",
      attachment: { type: "goal_status", met: false, condition: 42 },
    } as never)).toBeUndefined()
  })
})
