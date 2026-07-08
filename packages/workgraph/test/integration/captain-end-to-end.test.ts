import { describe, expect, test } from "vitest"
import { runTriage } from "../../src/captain/triage-runner"
import { WorkGraph } from "../../src/model/workgraph"

describe("Captain end-to-end", () => {
  test("manual normal triage can write a scratchpad and Captain can apply low-risk graph proposals", async () => {
    const wg = new WorkGraph(":memory:")
    const intake = wg.captureIntakeItem({
      kind: "manual",
      bodyMd: "We need implementation and QA for the async intake UI. Parent is unclear.",
      repoRef: "github:acme/app",
      triageModeOverride: "normal",
    })

    await runTriage(wg, intake.id, {
      spawn: async (input) => {
        input.workGraph.writeScratchpad({
          workItemId: input.workItemId,
          agentRunId: input.agentRunId,
          kind: "triage",
          content: [
            "Propose implementation task.",
            "Propose QA task.",
            "Ask where to attach the work.",
          ].join("\n"),
          actor: "triage",
        })
        return { sessionId: "triage_session_1", agentRunId: input.agentRunId }
      },
    }, {
      runCaptain: async (workGraph, agentRunId) => {
        const scratchpad = workGraph.getLatestScratchpadByRun(agentRunId)
        if (!scratchpad) throw new Error("missing scratchpad")
        workGraph.propose({
          intentKind: "add_node",
          subjectType: "intake_item",
          subjectId: intake.id,
          confidence: 0.94,
          evidenceMd: scratchpad.content,
          title: "Implement async intake UI",
          description: "Build the UI path.",
          parentId: null,
          labels: ["implementation"],
        })
        workGraph.propose({
          intentKind: "add_node",
          subjectType: "intake_item",
          subjectId: intake.id,
          confidence: 0.92,
          evidenceMd: scratchpad.content,
          title: "QA async intake UI",
          description: "Verify the UI path.",
          parentId: null,
          labels: ["qa"],
        })
        workGraph.propose({
          intentKind: "add_node",
          subjectType: "intake_item",
          subjectId: intake.id,
          confidence: 0.31,
          evidenceMd: scratchpad.content,
          title: "Choose parent mission",
          description: "Clarify placement.",
          parentId: null,
          labels: ["clarification"],
        })
        return { sessionId: "captain_hidden_1", events: workGraph.getEvents() }
      },
    })

    expect(wg.getAll().map((item) => item.title).sort()).toEqual([
      "Implement async intake UI",
      "QA async intake UI",
    ])
    expect(Object.values(wg.getState().decisions)).toEqual([
      expect.objectContaining({
        kind: "clarification",
        intentKind: "add_node",
        status: "open",
      }),
    ])
    expect(wg.getIntakeItem(intake.id)?.linkedSessionId).toBe("triage_session_1")
    wg.close()
  })
})
