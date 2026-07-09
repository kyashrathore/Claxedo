import { describe, expect, test } from "bun:test"
import { sync, type ACPState } from "./session"

describe("ACP session config sync", () => {
  test("maps app default model to Cursor ACP default option spelling", async () => {
    const calls: unknown[] = []
    const conn = {
      async request(_method: unknown, params: unknown) {
        calls.push(params)
        return { configOptions: state.cfg }
      },
    }
    const state: ACPState = {
      caps: null,
      prompt: null,
      modeIds: [],
      cfg: [{
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "gpt-5.5[reasoning=medium]",
        options: [{ value: "default[]", name: "Auto" }],
      }],
    }

    await sync(conn as never, state, "agent-session", {
      agent: "build",
      model: { providerID: "cursor-acp", modelID: "default" },
      parts: [],
    } as never)

    expect(calls).toEqual([expect.objectContaining({
      sessionId: "agent-session",
      configId: "model",
      value: "default[]",
    })])
  })
})
