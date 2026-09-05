import { describe, expect, test } from "bun:test"
import { MemoryRuntimeStore } from "../stores/memory"
import { requireExecutionBinding, assertSessionCreateBindingScope } from "./execution-binding"

function centralStore() {
  const store = new MemoryRuntimeStore()
  store.bindSession({ scope: "central", sessionId: "central-1", directory: "", connectionId: "native:pi", agentSessionId: "pi-1" })
  store.updateSessionConfig("central-1", { harness: { id: "pi", access: "native" } })
  return store
}

describe("central execution binding", () => {
  test("requires an explicit central scope and never invents a workspace", () => {
    const store = centralStore()
    expect(requireExecutionBinding(store, "central-1")).toEqual({
      scope: "central", sessionId: "central-1", directory: "", connectionId: "native:pi", upstreamSessionId: "pi-1",
    })
    expect(store.getExecutionBinding("central-1")?.workspaceId).toBeUndefined()
    const unscoped = new MemoryRuntimeStore()
    unscoped.bindSession({ sessionId: "central-1", directory: "", connectionId: "native:pi", agentSessionId: "pi-1" })
    expect(unscoped.getExecutionBinding("central-1")).toBeNull()
  })

  test("retains central scope across store snapshot recovery", () => {
    const original = centralStore()
    const recovered = new MemoryRuntimeStore()
    recovered.importSnapshot(original.exportSnapshot())
    expect(requireExecutionBinding(recovered, "central-1")).toEqual(requireExecutionBinding(original, "central-1"))
  })

  test("rejects routing a central session into another directory or harness", () => {
    const store = centralStore()
    expect(() => requireExecutionBinding(store, "central-1", "/tools-workspace")).toThrow("directory mismatch")
    expect(() => requireExecutionBinding(store, "central-1", undefined, { id: "claude", access: "native" })).toThrow("connectionId mismatch")
    expect(() => assertSessionCreateBindingScope(store, "central-1", {
      id: "central-1", workspaceId: "tools-workspace", directory: "/tools-workspace", harness: { id: "pi", access: "native" },
    })).toThrow("scope mismatch")
  })
})
