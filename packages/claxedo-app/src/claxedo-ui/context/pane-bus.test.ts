/**
 * Pane Bus Tests
 *
 * Verifies registration, cleanup, peer discovery, bindings,
 * message routing, dispatch, and reactivity.
 */
import { afterEach, describe, expect, mock, test } from "bun:test"
import { createEffect, createRoot } from "solid-js"
import {
  register,
  getPane,
  peers,
  peersWithCapability,
  siblings,
  bind,
  unbind,
  getBound,
  getBoundSources,
  autoBind,
  sendComment,
  sendCommentRemoval,
  sendCommentClear,
  notifyProducerRemoval,
  sendContextToggle,
  sendPageAiAction,
  sendPageAiOpen,
  dispatch,
  dispatchToCapability,
  queryModel,
  _reset,
  type PaneRegistration,
  type CommentPayload,
} from "./pane-bus"

afterEach(() => _reset())

function makeReg(overrides: Partial<PaneRegistration> & { leafId: string; tabId: string }): PaneRegistration {
  return {
    type: "session",
    name: () => "Test",
    capabilities: [],
    handlers: {},
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("registration", () => {
  test("register adds pane and getPane returns it", () => {
    const reg = makeReg({ leafId: "l1", tabId: "t1" })
    const cleanup = register(reg)
    expect(getPane("l1")).toBe(reg)
    cleanup()
  })

  test("cleanup removes pane", () => {
    const reg = makeReg({ leafId: "l1", tabId: "t1" })
    const cleanup = register(reg)
    cleanup()
    expect(getPane("l1")).toBeUndefined()
  })

  test("cleanup removes bindings where pane is source", () => {
    const r1 = makeReg({ leafId: "l1", tabId: "t1" })
    const r2 = makeReg({ leafId: "l2", tabId: "t1" })
    const c1 = register(r1)
    register(r2)
    bind("comment", "l1", "l2")
    expect(getBound("comment", "l1")).toBe("l2")
    c1()
    expect(getBound("comment", "l1")).toBeNull()
  })

  test("cleanup removes bindings where pane is target", () => {
    const r1 = makeReg({ leafId: "l1", tabId: "t1" })
    const r2 = makeReg({ leafId: "l2", tabId: "t1" })
    register(r1)
    const c2 = register(r2)
    bind("comment", "l1", "l2")
    c2()
    expect(getBound("comment", "l1")).toBeNull()
  })

  test("re-registering same leafId replaces previous registration", () => {
    const r1 = makeReg({ leafId: "l1", tabId: "t1", type: "session" })
    const r2 = makeReg({ leafId: "l1", tabId: "t1", type: "terminal" })
    register(r1)
    register(r2)
    expect(getPane("l1")?.type).toBe("terminal")
  })
})

// ---------------------------------------------------------------------------
// Peer Discovery
// ---------------------------------------------------------------------------

describe("peer discovery", () => {
  test("peers returns all panes in same tab", () => {
    register(makeReg({ leafId: "l1", tabId: "t1" }))
    register(makeReg({ leafId: "l2", tabId: "t1" }))
    register(makeReg({ leafId: "l3", tabId: "t2" }))
    expect(peers("t1")).toHaveLength(2)
    expect(peers("t2")).toHaveLength(1)
  })

  test("peersWithCapability filters by capability", () => {
    register(makeReg({ leafId: "l1", tabId: "t1", capabilities: ["comment:receive"] }))
    register(makeReg({ leafId: "l2", tabId: "t1", capabilities: ["comment:produce"] }))
    register(makeReg({ leafId: "l3", tabId: "t1", capabilities: ["comment:receive"] }))
    expect(peersWithCapability("comment:receive", "t1")).toHaveLength(2)
    expect(peersWithCapability("comment:produce", "t1")).toHaveLength(1)
  })

  test("peersWithCapability scopes to tab", () => {
    register(makeReg({ leafId: "l1", tabId: "t1", capabilities: ["comment:receive"] }))
    register(makeReg({ leafId: "l2", tabId: "t2", capabilities: ["comment:receive"] }))
    expect(peersWithCapability("comment:receive", "t1")).toHaveLength(1)
  })

  test("siblings returns same-tab, different-leaf panes", () => {
    register(makeReg({ leafId: "l1", tabId: "t1" }))
    register(makeReg({ leafId: "l2", tabId: "t1" }))
    register(makeReg({ leafId: "l3", tabId: "t2" }))
    const sibs = siblings("l1")
    expect(sibs).toHaveLength(1)
    expect(sibs[0].leafId).toBe("l2")
  })

  test("siblings returns empty for unknown leaf", () => {
    expect(siblings("unknown")).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------

describe("bindings", () => {
  test("bind and getBound", () => {
    bind("comment", "l1", "l2")
    expect(getBound("comment", "l1")).toBe("l2")
  })

  test("unbind removes binding", () => {
    bind("comment", "l1", "l2")
    unbind("comment", "l1")
    expect(getBound("comment", "l1")).toBeNull()
  })

  test("getBound returns null for unbound", () => {
    expect(getBound("comment", "unknown")).toBeNull()
  })

  test("getBoundSources returns reverse lookup", () => {
    bind("comment", "l1", "l3")
    bind("comment", "l2", "l3")
    const sources = getBoundSources("comment", "l3")
    expect(sources).toHaveLength(2)
    expect(sources).toContain("l1")
    expect(sources).toContain("l2")
  })

  test("getBoundSources returns empty for no sources", () => {
    expect(getBoundSources("comment", "l1")).toHaveLength(0)
  })

  test("bind overwrites previous binding", () => {
    bind("comment", "l1", "l2")
    bind("comment", "l1", "l3")
    expect(getBound("comment", "l1")).toBe("l3")
  })
})

// ---------------------------------------------------------------------------
// Auto-bind
// ---------------------------------------------------------------------------

describe("autoBind", () => {
  test("binds when exactly one candidate", () => {
    register(makeReg({ leafId: "review", tabId: "t1", capabilities: ["comment:produce"] }))
    register(makeReg({ leafId: "session", tabId: "t1", capabilities: ["comment:receive"] }))
    autoBind("review", "comment", "comment:receive")
    expect(getBound("comment", "review")).toBe("session")
  })

  test("does not bind when multiple candidates", () => {
    register(makeReg({ leafId: "review", tabId: "t1", capabilities: ["comment:produce"] }))
    register(makeReg({ leafId: "s1", tabId: "t1", capabilities: ["comment:receive"] }))
    register(makeReg({ leafId: "s2", tabId: "t1", capabilities: ["comment:receive"] }))
    autoBind("review", "comment", "comment:receive")
    expect(getBound("comment", "review")).toBeNull()
  })

  test("does not bind when zero candidates", () => {
    register(makeReg({ leafId: "review", tabId: "t1", capabilities: ["comment:produce"] }))
    autoBind("review", "comment", "comment:receive")
    expect(getBound("comment", "review")).toBeNull()
  })

  test("does not overwrite existing binding", () => {
    register(makeReg({ leafId: "review", tabId: "t1", capabilities: ["comment:produce"] }))
    register(makeReg({ leafId: "s1", tabId: "t1", capabilities: ["comment:receive"] }))
    register(makeReg({ leafId: "s2", tabId: "t1", capabilities: ["comment:receive"] }))
    bind("comment", "review", "s1")
    autoBind("review", "comment", "comment:receive")
    expect(getBound("comment", "review")).toBe("s1")
  })

  test("ignores candidates in different tab", () => {
    register(makeReg({ leafId: "review", tabId: "t1", capabilities: ["comment:produce"] }))
    register(makeReg({ leafId: "session", tabId: "t2", capabilities: ["comment:receive"] }))
    autoBind("review", "comment", "comment:receive")
    expect(getBound("comment", "review")).toBeNull()
  })

  test("does not bind to self", () => {
    register(makeReg({ leafId: "review", tabId: "t1", capabilities: ["comment:produce", "comment:receive"] }))
    autoBind("review", "comment", "comment:receive")
    expect(getBound("comment", "review")).toBeNull()
  })

  test("binds file tree to review focus target when exactly one review exists", () => {
    register(makeReg({ leafId: "files", tabId: "t1" }))
    register(makeReg({ leafId: "review", tabId: "t1", capabilities: ["review:focus-file"] }))
    autoBind("files", "review", "review:focus-file")
    expect(getBound("review", "files")).toBe("review")
  })
})

// ---------------------------------------------------------------------------
// Comment Messaging
// ---------------------------------------------------------------------------

describe("comment messaging", () => {
  test("sendComment routes to bound consumer", () => {
    const onComment = mock(() => {})
    register(makeReg({
      leafId: "review",
      tabId: "t1",
      capabilities: ["comment:produce"],
    }))
    register(makeReg({
      leafId: "session",
      tabId: "t1",
      capabilities: ["comment:receive"],
      handlers: { "comment:receive": { onComment } },
    }))
    bind("comment", "review", "session")

    const payload: CommentPayload = { type: "file", path: "a.ts" }
    expect(sendComment("review", payload)).toBe(true)
    expect(onComment).toHaveBeenCalledWith(payload)
  })

  test("sendComment returns false when no binding", () => {
    register(makeReg({ leafId: "review", tabId: "t1" }))
    expect(sendComment("review", { type: "file", path: "a.ts" })).toBe(false)
  })

  test("sendComment returns false when target not found", () => {
    bind("comment", "review", "gone")
    expect(sendComment("review", { type: "file", path: "a.ts" })).toBe(false)
  })

  test("sendCommentRemoval routes to bound consumer", () => {
    const onRemove = mock(() => {})
    register(makeReg({
      leafId: "session",
      tabId: "t1",
      capabilities: ["comment:receive"],
      handlers: { "comment:receive": { onComment: () => {}, onRemove } },
    }))
    bind("comment", "review", "session")

    expect(sendCommentRemoval("review", "a.ts", "c1")).toBe(true)
    expect(onRemove).toHaveBeenCalledWith("a.ts", "c1")
  })

  test("sendCommentClear routes to bound consumer", () => {
    const onClear = mock(() => {})
    register(makeReg({
      leafId: "session",
      tabId: "t1",
      capabilities: ["comment:receive"],
      handlers: { "comment:receive": { onComment: () => {}, onClear } },
    }))
    bind("comment", "review", "session")

    sendCommentClear("review")
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  test("notifyProducerRemoval sends to all producers bound to consumer", () => {
    const handler1 = mock(() => {})
    const handler2 = mock(() => {})
    register(makeReg({
      leafId: "r1",
      tabId: "t1",
      capabilities: ["comment:produce"],
      handlers: { "comment:produce": { onRemoveFromConsumer: handler1 } },
    }))
    register(makeReg({
      leafId: "r2",
      tabId: "t1",
      capabilities: ["comment:produce"],
      handlers: { "comment:produce": { onRemoveFromConsumer: handler2 } },
    }))
    register(makeReg({ leafId: "session", tabId: "t1" }))
    bind("comment", "r1", "session")
    bind("comment", "r2", "session")

    notifyProducerRemoval("session", "a.ts", "c1")
    expect(handler1).toHaveBeenCalledWith("a.ts", "c1")
    expect(handler2).toHaveBeenCalledWith("a.ts", "c1")
  })

  test("notifyProducerRemoval does nothing when no bindings", () => {
    // Should not throw
    notifyProducerRemoval("session", "a.ts", "c1")
  })
})

// ---------------------------------------------------------------------------
// Context Toggle
// ---------------------------------------------------------------------------

describe("context toggle", () => {
  test("sendContextToggle calls handler", () => {
    const handler = mock(() => {})
    register(makeReg({
      leafId: "review",
      tabId: "t1",
      capabilities: ["context:toggle"],
      handlers: { "context:toggle": handler },
    }))
    expect(sendContextToggle("review", "s1")).toBe(true)
    expect(handler).toHaveBeenCalledWith("s1")
  })

  test("sendContextToggle returns false when no handler", () => {
    register(makeReg({ leafId: "review", tabId: "t1" }))
    expect(sendContextToggle("review")).toBe(false)
  })

  test("sendContextToggle returns false when pane not found", () => {
    expect(sendContextToggle("nonexistent")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Page AI Messaging
// ---------------------------------------------------------------------------

describe("page AI messaging", () => {
  test("sendPageAiAction dispatches to page-ai:receive panes", () => {
    const onAction = mock(() => {})
    const onOpen = mock(() => {})
    register(makeReg({
      leafId: "page1",
      tabId: "t1",
      capabilities: ["page-ai:receive"],
      handlers: { "page-ai:receive": { onAction, onOpen } },
    }))
    const count = sendPageAiAction("t1", "improve", "make it better")
    expect(count).toBe(1)
    expect(onAction).toHaveBeenCalledWith("improve", "make it better")
    expect(onOpen).not.toHaveBeenCalled()
  })

  test("sendPageAiOpen dispatches to page-ai:receive panes", () => {
    const onAction = mock(() => {})
    const onOpen = mock(() => {})
    register(makeReg({
      leafId: "page1",
      tabId: "t1",
      capabilities: ["page-ai:receive"],
      handlers: { "page-ai:receive": { onAction, onOpen } },
    }))
    const count = sendPageAiOpen("t1")
    expect(count).toBe(1)
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onAction).not.toHaveBeenCalled()
  })

  test("sendPageAiAction scopes to tab", () => {
    const fn1 = mock(() => {})
    const fn2 = mock(() => {})
    register(makeReg({
      leafId: "page1",
      tabId: "t1",
      capabilities: ["page-ai:receive"],
      handlers: { "page-ai:receive": { onAction: fn1, onOpen: () => {} } },
    }))
    register(makeReg({
      leafId: "page2",
      tabId: "t2",
      capabilities: ["page-ai:receive"],
      handlers: { "page-ai:receive": { onAction: fn2, onOpen: () => {} } },
    }))
    sendPageAiAction("t1", "fix")
    expect(fn1).toHaveBeenCalledTimes(1)
    expect(fn2).not.toHaveBeenCalled()
  })

  test("sendPageAiAction returns 0 when no receivers", () => {
    expect(sendPageAiAction("t1", "improve")).toBe(0)
  })

  test("dispatch page-ai:action routes to handler", () => {
    const onAction = mock(() => {})
    register(makeReg({
      leafId: "page1",
      tabId: "t1",
      capabilities: ["page-ai:receive"],
      handlers: { "page-ai:receive": { onAction, onOpen: () => {} } },
    }))
    expect(dispatch("page1", { type: "page-ai:action", payload: { action: "summarize" } })).toBe(true)
    expect(onAction).toHaveBeenCalledWith("summarize", undefined)
  })

  test("dispatch page-ai:open routes to handler", () => {
    const onOpen = mock(() => {})
    register(makeReg({
      leafId: "page1",
      tabId: "t1",
      capabilities: ["page-ai:receive"],
      handlers: { "page-ai:receive": { onAction: () => {}, onOpen } },
    }))
    expect(dispatch("page1", { type: "page-ai:open" })).toBe(true)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  test("dispatch page-ai:action returns false without handler", () => {
    register(makeReg({ leafId: "l1", tabId: "t1" }))
    expect(dispatch("l1", { type: "page-ai:action", payload: { action: "improve" } })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Model Query
// ---------------------------------------------------------------------------

describe("model query", () => {
  test("queryModel returns model from provider pane", () => {
    register(makeReg({
      leafId: "ses1",
      tabId: "t1",
      capabilities: ["model:provide"],
      handlers: { "model:provide": () => ({ providerID: "minimax", modelID: "minimax-01" }) },
    }))
    expect(queryModel("t1")).toEqual({ providerID: "minimax", modelID: "minimax-01" })
  })

  test("queryModel returns undefined when no provider", () => {
    register(makeReg({ leafId: "l1", tabId: "t1" }))
    expect(queryModel("t1")).toBeUndefined()
  })

  test("queryModel returns undefined when handler returns undefined", () => {
    register(makeReg({
      leafId: "ses1",
      tabId: "t1",
      capabilities: ["model:provide"],
      handlers: { "model:provide": () => undefined },
    }))
    expect(queryModel("t1")).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

describe("dispatch", () => {
  test("dispatch comment:add routes to comment:receive handler", () => {
    const onComment = mock(() => {})
    register(makeReg({
      leafId: "l1",
      tabId: "t1",
      capabilities: ["comment:receive"],
      handlers: { "comment:receive": { onComment } },
    }))
    const payload: CommentPayload = { type: "file", path: "b.ts" }
    expect(dispatch("l1", { type: "comment:add", payload })).toBe(true)
    expect(onComment).toHaveBeenCalledWith(payload)
  })

  test("dispatch comment:remove routes to onRemove", () => {
    const onRemove = mock(() => {})
    register(makeReg({
      leafId: "l1",
      tabId: "t1",
      capabilities: ["comment:receive"],
      handlers: { "comment:receive": { onComment: () => {}, onRemove } },
    }))
    expect(dispatch("l1", { type: "comment:remove", payload: { path: "a.ts", commentID: "c1" } })).toBe(true)
    expect(onRemove).toHaveBeenCalledWith("a.ts", "c1")
  })

  test("dispatch comment:clear routes to onClear", () => {
    const onClear = mock(() => {})
    register(makeReg({
      leafId: "l1",
      tabId: "t1",
      capabilities: ["comment:receive"],
      handlers: { "comment:receive": { onComment: () => {}, onClear } },
    }))
    expect(dispatch("l1", { type: "comment:clear" })).toBe(true)
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  test("dispatch context:toggle routes to handler", () => {
    const handler = mock(() => {})
    register(makeReg({
      leafId: "l1",
      tabId: "t1",
      capabilities: ["context:toggle"],
      handlers: { "context:toggle": handler },
    }))
    expect(dispatch("l1", { type: "context:toggle", payload: { sessionId: "s1" } })).toBe(true)
    expect(handler).toHaveBeenCalledWith("s1")
  })

  test("dispatch returns false for unknown pane", () => {
    expect(dispatch("unknown", { type: "comment:clear" })).toBe(false)
  })

  test("dispatch returns false for custom without onAction", () => {
    register(makeReg({ leafId: "l1", tabId: "t1" }))
    expect(dispatch("l1", { type: "custom", channel: "x", payload: 42 })).toBe(false)
  })

  test("dispatch custom calls onAction", () => {
    const onAction = mock(() => {})
    register(makeReg({ leafId: "l1", tabId: "t1", onAction }))
    const action = { type: "custom" as const, channel: "x", payload: 42 }
    expect(dispatch("l1", action)).toBe(true)
    expect(onAction).toHaveBeenCalledWith(action)
  })

  test("dispatch prefers onAction over standard handlers", () => {
    const onAction = mock(() => {})
    const onComment = mock(() => {})
    register(makeReg({
      leafId: "l1",
      tabId: "t1",
      capabilities: ["comment:receive"],
      handlers: { "comment:receive": { onComment } },
      onAction,
    }))
    dispatch("l1", { type: "comment:add", payload: { type: "file", path: "a.ts" } })
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(onComment).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// dispatchToCapability
// ---------------------------------------------------------------------------

describe("dispatchToCapability", () => {
  test("broadcasts to all panes with capability in tab", () => {
    const fn1 = mock(() => {})
    const fn2 = mock(() => {})
    register(makeReg({
      leafId: "l1",
      tabId: "t1",
      capabilities: ["comment:receive"],
      handlers: { "comment:receive": { onComment: fn1 } },
    }))
    register(makeReg({
      leafId: "l2",
      tabId: "t1",
      capabilities: ["comment:receive"],
      handlers: { "comment:receive": { onComment: fn2 } },
    }))
    register(makeReg({
      leafId: "l3",
      tabId: "t2",
      capabilities: ["comment:receive"],
      handlers: { "comment:receive": { onComment: mock(() => {}) } },
    }))

    const count = dispatchToCapability("t1", "comment:receive", {
      type: "comment:add",
      payload: { type: "file", path: "c.ts" },
    })
    expect(count).toBe(2)
    expect(fn1).toHaveBeenCalledTimes(1)
    expect(fn2).toHaveBeenCalledTimes(1)
  })

  test("returns 0 when no matching panes", () => {
    expect(dispatchToCapability("t1", "comment:receive", { type: "comment:clear" })).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Reactivity
// ---------------------------------------------------------------------------

describe("reactivity", () => {
  test("peers is reactive to registrations", () => {
    const values: number[] = []
    let dispose!: () => void

    createRoot((d) => {
      dispose = d
      createEffect(() => {
        values.push(peers("t1").length)
      })
    })

    expect(values).toEqual([0])

    const c1 = register(makeReg({ leafId: "l1", tabId: "t1" }))
    expect(values).toEqual([0, 1])

    register(makeReg({ leafId: "l2", tabId: "t1" }))
    expect(values).toEqual([0, 1, 2])

    c1()
    expect(values).toEqual([0, 1, 2, 1])

    dispose()
  })

  test("getBound is reactive to bind/unbind", () => {
    const values: (string | null)[] = []
    let dispose!: () => void

    createRoot((d) => {
      dispose = d
      createEffect(() => {
        values.push(getBound("comment", "l1"))
      })
    })

    expect(values).toEqual([null])

    bind("comment", "l1", "l2")
    expect(values).toEqual([null, "l2"])

    unbind("comment", "l1")
    expect(values).toEqual([null, "l2", null])

    dispose()
  })
})

// ---------------------------------------------------------------------------
// _reset
// ---------------------------------------------------------------------------

describe("_reset", () => {
  test("clears all state", () => {
    register(makeReg({ leafId: "l1", tabId: "t1" }))
    bind("comment", "l1", "l2")
    _reset()
    expect(getPane("l1")).toBeUndefined()
    expect(getBound("comment", "l1")).toBeNull()
  })
})
