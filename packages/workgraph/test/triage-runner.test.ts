import { afterEach, describe, expect, test, vi } from "vitest"
import { createTriageDebouncer, runTriage } from "../src/captain/triage-runner"
import { WorkGraph } from "../src/model/workgraph"

describe("Triage runner", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test("runs visible triage, stores the linked session, writes a scratchpad, then invokes Captain", async () => {
    const wg = new WorkGraph(":memory:")
    const intake = wg.captureIntakeItem({
      kind: "manual",
      bodyMd: "Please split the onboarding cleanup into tasks.",
      repoRef: "github:acme/app",
      triageModeOverride: "normal",
    })
    const captainRuns: string[] = []

    const result = await runTriage(wg, intake.id, {
      spawn: async (input) => {
        expect(input.visible).toBe(true)
        expect(input.loadout.name).toBe("normal")
        input.workGraph.writeScratchpad({
          workItemId: input.workItemId,
          agentRunId: input.agentRunId,
          kind: "triage",
          content: "Create onboarding implementation and QA tasks.",
          actor: "triage",
        })
        return { sessionId: "triage_session_1", agentRunId: input.agentRunId }
      },
    }, {
      runCaptain: async (_wg, agentRunId) => {
        captainRuns.push(agentRunId)
        return { sessionId: "captain_hidden_1", events: [] }
      },
    })

    expect(result).toEqual(expect.objectContaining({
      status: "triaged",
      sessionId: "triage_session_1",
    }))
    expect(wg.getIntakeItem(intake.id)).toEqual(expect.objectContaining({
      status: "triaged",
      linkedSessionId: "triage_session_1",
      lastTriagedAt: expect.any(String),
    }))
    expect(captainRuns).toEqual([result.agentRunId])
    expect(wg.getLatestScratchpadByRun(result.agentRunId)?.kind).toBe("triage")
    wg.close()
  })

  test("does not mark intake triaged when the session does not write a scratchpad", async () => {
    const wg = new WorkGraph(":memory:")
    const intake = wg.captureIntakeItem({
      kind: "manual",
      bodyMd: "Please split this into tasks.",
      triageModeOverride: "normal",
    })

    await expect(runTriage(wg, intake.id, {
      spawn: async (input) => ({ sessionId: "triage_session_without_mcp", agentRunId: input.agentRunId }),
    })).rejects.toThrow("Scratchpad for agent run")

    expect(wg.getIntakeItem(intake.id)).toEqual(expect.objectContaining({
      status: "captured",
      linkedSessionId: "triage_session_without_mcp",
      lastTriagedAt: null,
    }))
    expect(wg.getState().intakeActivities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        intakeItemId: intake.id,
        kind: "triage_failed",
      }),
    ]))
    wg.close()
  })

  test("skips runner and Captain when TriageMode is off", async () => {
    const wg = new WorkGraph(":memory:")
    const intake = wg.captureIntakeItem({
      kind: "manual",
      bodyMd: "Just save this.",
      triageModeOverride: "off",
    })

    const result = await runTriage(wg, intake.id, {
      spawn: async () => {
        throw new Error("should not spawn")
      },
    })

    expect(result).toEqual({ status: "skipped", mode: "off" })
    expect(wg.getIntakeItem(intake.id)?.linkedSessionId).toBeNull()
    expect(wg.getScratchpads()).toEqual([])
    wg.close()
  })

  test("debounces repeated triage requests per IntakeItem", async () => {
    vi.useFakeTimers()
    const calls: string[] = []
    const debouncer = createTriageDebouncer((intakeItemId) => {
      calls.push(intakeItemId)
      return Promise.resolve()
    }, 500)

    debouncer.schedule("intake_1")
    debouncer.schedule("intake_1")
    debouncer.schedule("intake_1")
    await vi.advanceTimersByTimeAsync(499)
    expect(calls).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toEqual(["intake_1"])
  })
})
