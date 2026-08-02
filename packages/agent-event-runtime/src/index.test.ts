import { describe, expect, test } from "bun:test"

describe("package entrypoint", () => {
  test("imports in a browser-like runtime without Node globals", async () => {
    const entry = await import("./index")
    expect(typeof entry.createAgentEventRuntime).toBe("function")
    expect("createOpencodeCompatProjection" in entry).toBe(false)
    expect("createDebugTraceProjection" in entry).toBe(false)
    expect("createAcpEventTranslator" in entry).toBe(false)
  })

  test("exports documented package subpaths", async () => {
    const contracts = await import("@claxedo/agent-event-runtime/contracts")
    const opencodeCompat = await import("@claxedo/agent-event-runtime/opencode-compat")
    const opencodeCompatAlias = await import("@claxedo/agent-event-runtime/projections/opencode-compat")
    const debugTrace = await import("@claxedo/agent-event-runtime/debug-trace")
    const debugTraceAlias = await import("@claxedo/agent-event-runtime/projections/debug-trace")
    const acp = await import("@claxedo/agent-event-runtime/harnesses/acp")
    const claudeSdk = await import("@claxedo/agent-event-runtime/harnesses/claude")
    const codexAppServer = await import("@claxedo/agent-event-runtime/harnesses/codex")
    const cursorSdk = await import("@claxedo/agent-event-runtime/harnesses/cursor")

    expect(typeof contracts.agentRuntimeEvent).toBe("object")
    expect(typeof opencodeCompat.createOpencodeCompatProjection).toBe("function")
    expect(typeof opencodeCompatAlias.createOpencodeCompatProjection).toBe("function")
    expect(typeof debugTrace.createDebugTraceProjection).toBe("function")
    expect(typeof debugTraceAlias.createDebugTraceProjection).toBe("function")
    expect(typeof acp.createAcpEventTranslator).toBe("function")
    expect(typeof claudeSdk.claudeSdkAdapter).toBe("function")
    expect(typeof codexAppServer.codexAppServerAdapter).toBe("function")
    expect(typeof cursorSdk.cursorSdkAdapter).toBe("function")
  })
})
