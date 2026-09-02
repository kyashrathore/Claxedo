import { describe, expect, test } from "bun:test"
import { runtimeSnapshot } from "@claxedo/agent-event-runtime"
import { createMemoryRuntimeStore } from "../../stores/memory"
import { storeRows } from "../../test-utils/store-internals"
import { createAgentSessionIndex } from "./agent-session-index"
import { SdkRuntimeAdapter, type SdkRuntimeDriver, type SdkRuntimeDriverHost } from "./sdk-runtime-adapter"

describe("agent session index", () => {
  test("a provider session resolves back to its runtime session and scope", () => {
    const index = createAgentSessionIndex()
    index.remember({ sessionId: "session-1", directory: "/work", agentSessionId: "thread-1" })
    expect(index.get("thread-1")).toEqual({ sessionId: "session-1", directory: "/work" })
    expect(index.get("thread-unknown")).toBeNull()
  })

  test("a session without a provider id records nothing", () => {
    const index = createAgentSessionIndex()
    index.remember({ sessionId: "session-1", directory: "/work", agentSessionId: null })
    expect(index.get("")).toBeNull()
  })

  test("rebinding a session retires its previous provider id", () => {
    const index = createAgentSessionIndex()
    index.remember({ sessionId: "session-1", directory: "/work", agentSessionId: "thread-1" })
    index.remember({ sessionId: "session-1", directory: "/work", agentSessionId: "thread-2" })
    expect(index.get("thread-1")).toBeNull()
    expect(index.get("thread-2")).toEqual({ sessionId: "session-1", directory: "/work" })
  })

  test("forgetting a session drops the provider id that pointed at it", () => {
    const index = createAgentSessionIndex()
    index.remember({ sessionId: "session-1", directory: "/work", agentSessionId: "thread-1" })
    index.forget("session-1")
    expect(index.get("thread-1")).toBeNull()
  })
})

function driverStub(capture: (host: SdkRuntimeDriverHost) => void): (host: SdkRuntimeDriverHost) => SdkRuntimeDriver {
  return (host) => {
    capture(host)
    return {
      type: "codex",
      setAuth() {},
      applyConfig() {},
      createAgentSession: async () => "thread-1",
      createRuntime() {
        const snapshot = () => runtimeSnapshot({ harness: "codex", threadId: "thread-1", adapterState: {} })
        return { ingest: () => ({ state: {}, events: [], snapshot: snapshot() }), snapshot }
      },
      runTurn: async () => {},
      readRuntimeHealth: () => ({ status: "ok" }),
      configOptions: async () => [],
      peekConfigOptions: () => [],
    }
  }
}

describe("SdkRuntimeAdapter provider-id reverse lookup", () => {
  test("a driver can resolve the session behind a thread it has no live turn for", async () => {
    let host: SdkRuntimeDriverHost | undefined
    const adapter = new SdkRuntimeAdapter({
      store: storeRows(createMemoryRuntimeStore()),
      driver: driverStub((created) => {
        host = created
      }),
    })
    expect(host?.getSessionForAgentSession?.("thread-1")).toBeNull()

    await adapter.createSession("/work", "Ship", "session-1")
    expect(host?.getSessionForAgentSession?.("thread-1")).toEqual({ sessionId: "session-1", directory: "/work" })

    await adapter.deleteSession("session-1", "/work")
    expect(host?.getSessionForAgentSession?.("thread-1")).toBeNull()
    adapter.dispose()
  })
})
