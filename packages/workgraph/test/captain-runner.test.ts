import { describe, expect, test } from "vitest"
import { runCaptain } from "../src/captain/runner"
import { WorkGraph } from "../src/model/workgraph"

describe("Captain runner", () => {
  test("reads the latest scratchpad and runs the Captain silently against the Captain surface", async () => {
    const wg = new WorkGraph(":memory:")
    const item = wg.create({ title: "Existing task" })
    wg.writeScratchpad({
      workItemId: item.id,
      agentRunId: "agent_run_1",
      kind: "executor",
      content: "Need a follow-up docs task.",
      actor: "agent",
    })

    const result = await runCaptain(wg, "agent_run_1", {
      run: async (input) => {
        expect(input.toolsRole).toBe("captain")
        expect(input.scratchpad.content).toContain("follow-up")
        input.workGraph.propose({
          intentKind: "add_node",
          subjectType: "work_item",
          subjectId: item.id,
          confidence: 0.94,
          evidenceMd: input.scratchpad.content,
          title: "Write follow-up docs",
          description: "Document the result.",
          parentId: null,
          labels: ["docs"],
        })
        return { sessionId: "captain_hidden_1" }
      },
    })

    expect(result.sessionId).toBe("captain_hidden_1")
    expect(result.events.map((event) => event.type)).toEqual(["captain_proposed", "item_created"])
    expect(wg.getAll().map((row) => row.title)).toContain("Write follow-up docs")
    wg.close()
  })

  test("emits captain_failed and preserves the scratchpad when the Captain runtime throws", async () => {
    const wg = new WorkGraph(":memory:")
    const item = wg.create({ title: "Existing task" })
    const scratchpad = wg.writeScratchpad({
      workItemId: item.id,
      agentRunId: "agent_run_1",
      content: "Divergent result",
      actor: "agent",
    })

    await expect(runCaptain(wg, "agent_run_1", {
      run: async () => {
        throw new Error("tool unavailable")
      },
    })).rejects.toThrow("tool unavailable")

    expect(wg.getLatestScratchpadByRun("agent_run_1")?.id).toBe(scratchpad.id)
    expect(JSON.parse(wg.getEvents().at(-1)!.payload)).toEqual(expect.objectContaining({
      agentRunId: "agent_run_1",
      scratchpadId: scratchpad.id,
      errorClass: "Error",
    }))
    expect(wg.getEvents().at(-1)?.type).toBe("captain_failed")
    wg.close()
  })
})
