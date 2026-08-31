import { describe, expect, test } from "bun:test"
import type { Query, SDKActiveGoalMessage } from "@anthropic-ai/claude-agent-sdk"
import { createSessionTurnLifecycle } from "../shared/turn-lifecycle"
import type { SdkRuntimeTurnInput } from "../shared/sdk-runtime-adapter"
import {
  claudeGoalCommand,
  claudeGoalSnapshot,
  claudeTranscriptGoalSnapshot,
  createClaudeSdkDriver,
} from "./driver"

describe("Claude native Goal lifecycle", () => {
  test("sends /goal through query and accepts the CLI transcript Goal authority", async () => {
    const calls: unknown[] = []
    const published: unknown[] = []
    const fakeQuery = ((input: {
      options: {
        sessionStore: { append(key: { projectKey: string; sessionId: string }, entries: unknown[]): Promise<void> }
      }
    }) => {
      calls.push(input)
      const stream = (async function* () {
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
    const lifecycle = createSessionTurnLifecycle()
    const driver = createClaudeSdkDriver({
      lifecycle: () => lifecycle as never,
      pendingPermissions: new Map(),
      pendingQuestions: new Map(),
      bindSession() {},
      getAgentSessionId: () => "claude-session",
      getSessionConfig: () => null,
      publishGoal(input) {
        published.push(input.goal)
      },
      async runProviderTurn() { return true },
    }, {
      query: fakeQuery,
      executable: () => "/fake/claude",
      importSession: async () => {},
    })
    const observed: unknown[] = []
    const input = {
      sessionId: "session-1",
      getAgentSessionId: () => "claude-session",
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

    await driver.nativeGoal!.run(input, "Ship when checks pass", (goal) => observed.push(goal))

    expect(claudeGoalCommand("Ship when checks pass")).toBe("/goal Ship when checks pass")
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
    // Delete must not be advertised: the Claude CLI session has no provider
    // clear operation, so a resumed session would re-emit a "deleted" Goal.
    expect(await driver.nativeGoal!.capabilities("session-1", "/repo")).toMatchObject({
      actions: [],
    })
    expect(await driver.nativeGoal!.read("session-1", "/repo")).toMatchObject({ status: "paused" })
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
  })
})
