import { describe, expect, test } from "bun:test"

describe("package entrypoint", () => {
  test("imports in a browser-like runtime without Node globals", async () => {
    const entry = await import("./index")
    expect(typeof entry.agentRuntimeEvent).toBe("object")
    expect(typeof entry.runtimeSnapshot).toBe("function")
    expect("createClientPresentationProjection" in entry).toBe(false)
    expect("createDebugTraceProjection" in entry).toBe(false)
    expect("createAgentEventRuntime" in entry).toBe(false)
  })

  test("exports documented package subpaths", async () => {
    const contracts = await import("@claxedo/agent-event-runtime/contracts")
    const clientPresentation = await import("@claxedo/agent-event-runtime/client-presentation")
    const clientPresentationAlias = await import("@claxedo/agent-event-runtime/projections/client-presentation")
    const debugTrace = await import("@claxedo/agent-event-runtime/debug-trace")
    const debugTraceAlias = await import("@claxedo/agent-event-runtime/projections/debug-trace")
    expect(typeof contracts.agentRuntimeEvent).toBe("object")
    expect(typeof clientPresentation.createClientPresentationProjection).toBe("function")
    expect(typeof clientPresentationAlias.createClientPresentationProjection).toBe("function")
    expect(typeof debugTrace.createDebugTraceProjection).toBe("function")
    expect(typeof debugTraceAlias.createDebugTraceProjection).toBe("function")
  })
})
