import { describe, expect, test } from "bun:test"
import { createSessionTurnLifecycle } from "../shared/turn-lifecycle"
import type { SdkRuntimeTurnInput } from "../shared/sdk-runtime-adapter"
import { nativeGoalCommand } from "../shared/native-goal-store"
import { createCursorSdkDriver } from "./driver"

describe("Cursor native Goal lifecycle", () => {
  test("sends /goal through Agent.send and derives state only from the durable Run", async () => {
    const sent: unknown[] = []
    const observed: unknown[] = []
    const published: unknown[] = []
    const run = {
      id: "run-1",
      async *stream() {},
      wait: async () => ({ id: "run-1", status: "finished" as const }),
      cancel: async () => {},
    }
    const agent = {
      agentId: "cursor-agent-1",
      model: undefined,
      send: async (message: string, options: unknown) => {
        sent.push({ message, options })
        return run
      },
      close() {},
      reload: async () => {},
      listArtifacts: async () => [],
      downloadArtifact: async () => Buffer.from([]),
      [Symbol.asyncDispose]: async () => {},
    }
    const lifecycle = createSessionTurnLifecycle()
    const driver = createCursorSdkDriver({
      lifecycle: () => lifecycle as never,
      pendingPermissions: new Map(),
      pendingQuestions: new Map(),
      bindSession() {},
      getAgentSessionId: () => "cursor-agent-1",
      getSessionConfig: () => null,
      publishGoal(input) {
        published.push(input.goal)
      },
      async runProviderTurn() { return true },
    }, {
      loadAgent: async () => ({
        Agent: { resume: async () => agent } as never,
      }),
    })
    const input = {
      sessionId: "session-1",
      getAgentSessionId: () => "cursor-agent-1",
      input: {
        parts: [{ type: "text", text: "Ship when checks pass" }],
        userMessageId: "user-1",
        assistantMessageId: "assistant-1",
        agent: "build",
        model: { providerID: "cursor", modelID: "auto" },
      },
      directory: "/repo",
      abort: new AbortController(),
      ingest() {},
      associateChild() {},
      observeSubagent: async () => ({ event: {} }),
      rebindAgentSession() {},
      model: "auto",
    } as unknown as SdkRuntimeTurnInput

    driver.setAuth({ cursor: "cursor-test-key" })
    await driver.nativeGoal!.run(input, "Ship when checks pass", (goal) => observed.push(goal))

    expect(nativeGoalCommand("Ship when checks pass")).toBe("/goal Ship when checks pass")
    expect(sent).toMatchObject([{
      message: "/goal Ship when checks pass",
      options: { local: { force: false } },
    }])
    expect(observed).toMatchObject([
      { sessionId: "session-1", objective: "Ship when checks pass", status: "active" },
      { sessionId: "session-1", objective: "Ship when checks pass", status: "complete" },
    ])
    expect(published).toEqual(observed)
    // Delete must not be advertised: cursor-agent has no provider clear
    // operation, so a resumed session would re-emit a "deleted" Goal.
    expect(await driver.nativeGoal!.capabilities("session-1", "/repo")).toMatchObject({
      implemented: true,
      available: true,
      actions: [],
      recovery: "blocked",
    })
    expect(await driver.nativeGoal!.read("session-1", "/repo")).toMatchObject({ status: "complete" })
  })

  test("settles the Goal as blocked when the Run stream dies instead of leaving it active", async () => {
    const observed: unknown[] = []
    const published: unknown[] = []
    const run = {
      id: "run-1",
      // eslint-disable-next-line require-yield
      async *stream(): AsyncGenerator<never> {
        throw new Error("cursor-agent exited")
      },
      wait: async () => ({ id: "run-1", status: "finished" as const }),
      cancel: async () => {},
    }
    const agent = {
      agentId: "cursor-agent-1",
      send: async () => run,
      close() {},
    }
    const lifecycle = createSessionTurnLifecycle()
    const driver = createCursorSdkDriver({
      lifecycle: () => lifecycle as never,
      pendingPermissions: new Map(),
      pendingQuestions: new Map(),
      bindSession() {},
      getAgentSessionId: () => "cursor-agent-1",
      getSessionConfig: () => null,
      publishGoal(input) {
        published.push(input.goal)
      },
      async runProviderTurn() { return true },
    }, {
      loadAgent: async () => ({
        Agent: { resume: async () => agent } as never,
      }),
    })
    const input = {
      sessionId: "session-1",
      getAgentSessionId: () => "cursor-agent-1",
      input: {
        parts: [{ type: "text", text: "Ship when checks pass" }],
        userMessageId: "user-1",
        assistantMessageId: "assistant-1",
        agent: "build",
        model: { providerID: "cursor", modelID: "auto" },
      },
      directory: "/repo",
      abort: new AbortController(),
      ingest() {},
      associateChild() {},
      observeSubagent: async () => ({ event: {} }),
      rebindAgentSession() {},
      model: "auto",
    } as unknown as SdkRuntimeTurnInput

    driver.setAuth({ cursor: "cursor-test-key" })
    await expect(driver.nativeGoal!.run(input, "Ship when checks pass", (goal) => observed.push(goal)))
      .rejects.toThrow("cursor-agent exited")

    // Nothing is left running to advance the Goal, so it must not stay active.
    expect(observed).toMatchObject([
      { status: "active" },
      { status: "blocked", lastReason: "cursor-agent exited" },
    ])
    expect(published).toEqual(observed)
    expect(await driver.nativeGoal!.read("session-1", "/repo")).toMatchObject({
      status: "blocked",
      lastReason: "cursor-agent exited",
    })
  })

  test("reports the installed implementation unavailable without Cursor SDK credentials", async () => {
    const driver = createCursorSdkDriver({
      lifecycle: () => createSessionTurnLifecycle() as never,
      pendingPermissions: new Map(),
      pendingQuestions: new Map(),
      bindSession() {},
      getAgentSessionId: () => "cursor-agent-1",
      getSessionConfig: () => null,
      publishGoal() {},
      async runProviderTurn() { return true },
    })

    expect(driver.nativeGoal!.capabilities("session-1", "/repo")).toMatchObject({
      implemented: true,
      available: false,
      unavailableReason: "Cursor SDK requires an explicit cursor-sdk API key. Cursor ACP can use the local Cursor login.",
    })
  })
})
