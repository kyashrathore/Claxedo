import { describe, expect, test } from "bun:test"
import { init, merge, modeIds, sync, type ACPState } from "./session"

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
      modes: [],
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

describe("ACP advertised modes", () => {
  const base = () => init(null)

  test("preserves the agent's own name and description, not just the id", () => {
    const state = merge(base(), {
      modes: {
        currentModeId: "default",
        availableModes: [
          { id: "default", name: "Ask every time", description: "Prompt before edits and commands" },
          { id: "acceptEdits", name: "Accept edits" },
        ],
      },
    })
    // `SessionModeId` is an open `string` in the spec, so these labels are the
    // ONLY non-invented text a client can show for a mode.
    expect(state.modes).toEqual([
      { id: "default", name: "Ask every time", description: "Prompt before edits and commands" },
      { id: "acceptEdits", name: "Accept edits" },
    ])
    expect(modeIds(state)).toEqual(["default", "acceptEdits"])
  })

  test("drops malformed modes rather than fabricating a label", () => {
    const state = merge(base(), {
      modes: {
        currentModeId: "ok",
        availableModes: [
          { id: "ok", name: "Fine" },
          { id: "no-name" },
          { name: "no-id" },
          null,
          "nonsense",
          { id: 7, name: "wrong types" },
        ],
      },
    })
    expect(state.modes).toEqual([{ id: "ok", name: "Fine" }])
  })

  test("omits an absent description instead of storing null", () => {
    const state = merge(base(), {
      modes: { currentModeId: "a", availableModes: [{ id: "a", name: "A", description: null }] },
    })
    expect(state.modes).toEqual([{ id: "a", name: "A" }])
    expect("description" in state.modes[0]!).toBe(false)
  })

  test("an explicit null modes field clears them; undefined leaves them alone", () => {
    const withModes = merge(base(), {
      modes: { currentModeId: "a", availableModes: [{ id: "a", name: "A" }] },
    })
    expect(merge(withModes, { modes: null }).modes).toEqual([])
    expect(merge(withModes, {}).modes).toEqual([{ id: "a", name: "A" }])
  })

  test("a agent advertising no modes yields an empty list, never undefined", () => {
    expect(merge(base(), { modes: { currentModeId: "", availableModes: [] } }).modes).toEqual([])
    expect(merge(base(), { modes: {} }).modes).toEqual([])
    expect(base().modes).toEqual([])
  })
})
