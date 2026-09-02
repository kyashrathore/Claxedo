import path from "node:path"
import { describe, expect, it } from "bun:test"
import type { WithInternals } from "../../test-utils/class-internals"
import { AcpHarnessAdapter } from "./index"
import { ACPProcess } from "./process"

type ProcessInternals = {
  agent: { request(method: string, params: unknown): Promise<{ sessionId: string }> }
  idle: { touch(): void }
  mcp: () => never[]
  states: Map<string, unknown>
  caps: null
  /** Backs the `alive` getter the adapter checks before reading a process's cache. */
  transport: { alive: boolean }
}

/**
 * An `ACPProcess` wired to a scripted agent.
 *
 * The constructor spawns a real binary, so the process is fabricated the way
 * this package's other harness doubles are and only the connection is scripted.
 * Everything after `session/new` answers — state merge, discovery cache, the
 * payload the adapter reads — is the production code path.
 */
function acpProcess(answer: Record<string, unknown>) {
  const proc = Object.create(ACPProcess.prototype) as WithInternals<ACPProcess, ProcessInternals>
  Object.assign(proc, {
    agent: { request: async () => answer as { sessionId: string } },
    idle: { touch() {} },
    mcp: () => [],
    states: new Map(),
    caps: null,
    transport: { alive: true },
    cachedConfigOptions: null,
    cachedResolvedModel: null,
  })
  return proc
}

type FakeProcess = ReturnType<typeof acpProcess>

function adapterFor(proc: FakeProcess) {
  const out = Object.create(AcpHarnessAdapter.prototype) as WithInternals<AcpHarnessAdapter, {
    options: { binary: string; harness: string }
    sessions: Map<string, unknown>
    probe: { proc: FakeProcess; directory: string; init: null }
  }>
  Object.assign(out, {
    options: { binary: "fake-acp", harness: "openclaw" },
    sessions: new Map(),
    processes: new Map(),
    probe: { proc, directory: path.resolve("/work"), init: null },
  })
  return out
}

const liveOptions = [{ id: "mode", name: "Mode", category: "mode", type: "select", options: [{ value: "code", name: "Code" }] }]

describe("the model an ACP agent resolved for itself", () => {
  it("reaches the config-options payload when the agent reports a current model", async () => {
    const proc = acpProcess({
      sessionId: "agent-session",
      configOptions: liveOptions,
      models: {
        currentModelId: "openclaw-pro",
        availableModels: [
          { modelId: "openclaw-mini", name: "Openclaw Mini" },
          { modelId: "openclaw-pro", name: "Openclaw Pro" },
        ],
      },
    })
    await proc.newSession(path.resolve("/work"))

    const adapter = adapterFor(proc)
    expect(adapter.peekConfigOptions(path.resolve("/work"))).toEqual({
      options: liveOptions,
      resolvedModel: { id: "openclaw-pro", name: "Openclaw Pro" },
    })
    expect(await adapter.probeConfigOptions(path.resolve("/work"))).toEqual({
      options: liveOptions,
      resolvedModel: { id: "openclaw-pro", name: "Openclaw Pro" },
    })
  })

  it("carries no model field when the agent reports live options and no model", async () => {
    const proc = acpProcess({ sessionId: "agent-session", configOptions: liveOptions })
    await proc.newSession(path.resolve("/work"))

    const payload = await adapterFor(proc).probeConfigOptions(path.resolve("/work"))
    expect(payload).toEqual({ options: liveOptions })
    expect("resolvedModel" in payload).toBe(false)
  })

  it("carries no model field when the agent names a model it never described", async () => {
    const proc = acpProcess({
      sessionId: "agent-session",
      configOptions: liveOptions,
      models: { currentModelId: "openclaw-pro", availableModels: [{ modelId: "openclaw-mini", name: "Openclaw Mini" }] },
    })
    await proc.newSession(path.resolve("/work"))

    expect(await adapterFor(proc).probeConfigOptions(path.resolve("/work"))).toEqual({ options: liveOptions })
  })

  it("reads the model config option when that is the channel the agent speaks", async () => {
    const options = [{
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "openclaw-pro",
      options: [{ value: "openclaw-pro", name: "Openclaw Pro" }],
    }]
    const proc = acpProcess({ sessionId: "agent-session", configOptions: options })
    await proc.newSession(path.resolve("/work"))

    expect(await adapterFor(proc).probeConfigOptions(path.resolve("/work"))).toEqual({
      options,
      resolvedModel: { id: "openclaw-pro", name: "Openclaw Pro" },
    })
  })
})
