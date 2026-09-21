import { describe, expect, test } from "bun:test"
import { requireAgentExecutionBinding, type AgentExecutionBinding } from "@claxedo/agent-runtime-contract"
import { MemoryRuntimeStore } from "../stores/memory"
import { requireExecutionBinding, assertSessionCreateBindingScope } from "./execution-binding"

function machineStore() {
  const store = new MemoryRuntimeStore()
  store.bindSession({
    scope: "workspace",
    sessionId: "product-1",
    workspaceId: "workspace-1",
    directory: "/project",
    connectionId: "native:pi",
    agentSessionId: "native-pi-1",
  })
  store.updateSessionConfig("product-1", { harness: { id: "pi", access: "native" } })
  return store
}

describe("machine execution binding", () => {
  test("preserves native Pi identity separately across recovery", () => {
    const original = machineStore()
    const recovered = new MemoryRuntimeStore()
    recovered.importSnapshot(original.exportSnapshot())
    expect(requireExecutionBinding(recovered, "product-1")).toEqual({
      sessionId: "product-1",
      workspaceId: "workspace-1",
      directory: "/project",
      connectionId: "native:pi",
      upstreamSessionId: "native-pi-1",
    })
  })
  test("rejects split execution and directoryless bindings at the contract boundary", () => {
    const binding = requireExecutionBinding(machineStore(), "product-1")
    expect(() =>
      requireAgentExecutionBinding({ ...binding, scope: "central" } as unknown as AgentExecutionBinding),
    ).toThrow("workspace execution scope is required")
    expect(() => requireAgentExecutionBinding({ ...binding, directory: "" })).toThrow("directory is required")
    expect(() => requireAgentExecutionBinding({ ...binding, workspaceId: "" })).toThrow("workspaceId is required")
  })
  test("rejects a different directory, harness or machine", () => {
    const store = machineStore()
    expect(() => requireExecutionBinding(store, "product-1", "/other")).toThrow("directory mismatch")
    expect(() => requireExecutionBinding(store, "product-1", undefined, { id: "claude", access: "native" })).toThrow(
      "connectionId mismatch",
    )
    expect(() =>
      assertSessionCreateBindingScope(store, "product-1", {
        id: "product-1",
        workspaceId: "other",
        directory: "/project",
        harness: { id: "pi", access: "native" },
      }),
    ).toThrow("workspaceId mismatch")
  })
})
