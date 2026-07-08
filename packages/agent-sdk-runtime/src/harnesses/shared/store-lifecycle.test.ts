import { describe, expect, test } from "bun:test"
import { AcpHarnessAdapter, type AcpRuntimeStore } from "../acp"
import type { CompatEvent } from "../../compat-events"
import { CodexHarnessAdapter } from "../codex"
import type { AgentRuntimeCommittedCompatOutput } from "./runtime-store"
import type { SdkRuntimeStore } from "./sdk-runtime-adapter"

function committed(input: { sessionId: string; agentSessionId?: string; payload: CompatEvent }): AgentRuntimeCommittedCompatOutput {
  return {
    sessionId: input.sessionId,
    seq: 1,
    createdAt: 1,
    ...(input.agentSessionId ? { agentSessionId: input.agentSessionId } : {}),
    payload: input.payload,
  }
}

function acpStore(close?: () => void): AcpRuntimeStore {
  return {
    listSessions: () => [],
    getSession: () => null,
    bindSession: () => {},
    updateSessionConfig: () => null,
    updateSession: () => null,
    getSessionConfig: () => null,
    deleteSession: () => {},
    getAgentSessionId: () => null,
    startTurn: () => {},
    appendEvent: committed,
    getMessages: () => [],
    getTodos: () => [],
    listPermissions: () => [],
    stalePermission: () => {},
    markRecovering: () => {},
    markSessionInterrupted: () => {},
    consumeRecoveryError: () => null,
    ...(close ? { close } : {}),
  }
}

function sdkStore(close?: () => void): SdkRuntimeStore {
  return {
    listSessions: () => [],
    getSession: () => null,
    bindSession: () => {},
    updateSessionConfig: () => null,
    updateSession: () => null,
    getSessionConfig: () => null,
    deleteSession: () => {},
    getAgentSessionId: () => null,
    startTurn: () => {},
    appendEvent: committed,
    getMessages: () => [],
    getTodos: () => [],
    listPermissions: () => [],
    stalePermission: () => {},
    ...(close ? { close } : {}),
  }
}

describe("adapter store lifecycle", () => {
  test("AcpHarnessAdapter closes adapter-created stores once", () => {
    let closed = 0
    const adapter = new AcpHarnessAdapter({
      binary: "fake-acp",
      createStore: () => acpStore(() => {
        closed++
      }),
    })

    adapter.dispose()
    adapter.dispose()

    expect(closed).toBe(1)
  })

  test("AcpHarnessAdapter leaves caller-owned stores open", () => {
    let closed = 0
    const adapter = new AcpHarnessAdapter({
      binary: "fake-acp",
      store: acpStore(() => {
        closed++
      }),
    })

    adapter.dispose()

    expect(closed).toBe(0)
  })

  test("CodexHarnessAdapter closes adapter-created stores once", () => {
    let closed = 0
    const adapter = new CodexHarnessAdapter({
      createStore: () => sdkStore(() => {
        closed++
      }),
    })

    adapter.dispose()
    adapter.dispose()

    expect(closed).toBe(1)
  })

  test("CodexHarnessAdapter leaves caller-owned stores open", () => {
    let closed = 0
    const adapter = new CodexHarnessAdapter({
      store: sdkStore(() => {
        closed++
      }),
    })

    adapter.dispose()

    expect(closed).toBe(0)
  })
})
