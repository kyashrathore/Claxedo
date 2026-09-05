import { describe, expect, test } from "bun:test"
import { storeRows } from "../test-utils/store-internals"
import { createMemoryRuntimeStore } from "../stores/memory"
import type { WithInternals } from "../test-utils/class-internals"
import { AcpHarnessAdapter } from "./acp/index"
import { ClaudeHarnessAdapter } from "./claude/index"
import { CodexHarnessAdapter } from "./codex/index"
import { CursorHarnessAdapter } from "./cursor/index"
import { PiHarnessAdapter } from "./pi/index"
import {
  harnessCapabilities as canonicalHarnessCapabilities,
  type HarnessCapabilities,
} from "../capabilities"
import { harnessCapabilities as barrelHarnessCapabilities } from "../index"

const REQUIRED_KEYS: ReadonlyArray<keyof HarnessCapabilities> = [
  "harness",
  "abort",
  "reconnect",
  "replay",
  "permissions",
  "questions",
  "todos",
  "commands",
  "fork",
  "revert",
  "unrevert",
  "configOptions",
  "subagents",
  "goals",
]

type AcpBaseInternals = {
  options: { connection: { kind: "process"; command: string }; harness: string }
  processes: Map<string, unknown>
  sessionProcesses: Map<string, string>
  probe: null
}

/** `Extra` names the extra internals a given test drives; see acp/workspace-behavior.test.ts. */
function acpAdapterWithHarness<Extra extends object = Record<never, never>>(
  harness: string,
) {
  const adapter = Object.create(AcpHarnessAdapter.prototype) as WithInternals<
    AcpHarnessAdapter,
    Omit<AcpBaseInternals, keyof Extra> & Extra
  >
  const defaults: AcpBaseInternals = {
    options: { connection: { kind: "process", command: "test-acp" }, harness },
    processes: new Map(),
    sessionProcesses: new Map(),
    probe: null,
  }
  Object.assign(adapter, defaults)
  return adapter
}

function sdkAdapterWithDriver(type: "claude" | "codex" | "cursor") {
  const Adapter = type === "claude" ? ClaudeHarnessAdapter : type === "cursor" ? CursorHarnessAdapter : CodexHarnessAdapter
  const adapter = Object.create(Adapter.prototype) as WithInternals<(ClaudeHarnessAdapter | CodexHarnessAdapter | CursorHarnessAdapter), {
    driver: { type: "claude" | "codex" | "cursor" }
  }>
  adapter.driver = { type }
  return adapter
}

function assertCompleteShape(caps: HarnessCapabilities) {
  for (const key of REQUIRED_KEYS) {
    expect(caps, `missing key ${key}`).toHaveProperty(key)
  }
  for (const key of REQUIRED_KEYS) {
    if (key === "harness") continue
    expect(typeof caps[key], `${key} must be boolean`).toBe("boolean")
  }
}

describe("Agent SDK Runtime: HarnessCapabilities contract", () => {
  test("adapter barrel re-exports the canonical capability helper", () => {
    expect(barrelHarnessCapabilities).toBe(canonicalHarnessCapabilities)
  })

  test("an operator ACP adapter reports a complete capability manifest", () => {
    const caps = acpAdapterWithHarness("openclaw").readHarnessCapabilities()
    expect(caps.harness).toBe("openclaw")
    assertCompleteShape(caps)
  })

  test("native SDK harness adapters report a complete capability manifest", () => {
    for (const type of ["claude", "codex", "cursor"] as const) {
      const caps = sdkAdapterWithDriver(type).readHarnessCapabilities()
      expect(caps.harness).toBe(type)
      expect(caps.reconnect).toBe(false)
      expect(caps.fork).toBe(false)
      expect(caps.configOptions).toBe(true)
      assertCompleteShape(caps)
    }
  })

  test("native coding harnesses advertise subagents without assuming ACP extensions", () => {
    const adapters = (["claude", "codex", "cursor"] as const)
      .map((type) => sdkAdapterWithDriver(type).readHarnessCapabilities())
    expect(adapters.every((caps) => caps.subagents)).toBe(true)
    expect(acpAdapterWithHarness("openclaw").readHarnessCapabilities().subagents).toBe(false)
  })

  test("advertises Goal only when an adapter exposes the canonical resource", async () => {
    const unsupported = [
      acpAdapterWithHarness("openclaw").readHarnessCapabilities(),
      ...(["claude", "codex", "cursor"] as const).map((type) => sdkAdapterWithDriver(type).readHarnessCapabilities()),
    ]

    expect(unsupported.every((item) => ! item.goals)).toBe(true)
    expect((await new PiHarnessAdapter({ store: storeRows(createMemoryRuntimeStore()) }).readHarnessCapabilities()).goals).toBe(true)
  })

  test("native Pi reports questions and goals but no permission or subagent emulation", () => {
    const adapter = new PiHarnessAdapter({ store: storeRows(createMemoryRuntimeStore()) })
    const caps = adapter.readHarnessCapabilities()
    assertCompleteShape(caps)
    expect(caps).toMatchObject({ harness: "pi", goals: true, subagents: false, permissions: false, questions: true, replay: true, configOptions: true })
  })

  test("configOptions declares ACP model probing", () => {
    expect(acpAdapterWithHarness("openclaw").readHarnessCapabilities().configOptions).toBe(true)
  })

  test("ACP declares unsupported revert and command capabilities", () => {
    const caps = acpAdapterWithHarness("openclaw").readHarnessCapabilities()
    expect(caps.revert).toBe(false)
    expect(caps.unrevert).toBe(false)
    expect(caps.commands).toBe(false)
  })

  test("ACP supports baseline replay but does not advertise live reconnect", () => {
    const acp = acpAdapterWithHarness("openclaw").readHarnessCapabilities()
    for (const key of ["abort", "replay", "permissions"] as const) expect(acp[key]).toBe(true)
    expect(acp.reconnect).toBe(false)
    expect(acp.todos).toBe(false)
  })

  test("ACP fork is reported only for a live process that advertises session fork", () => {
    const adapter = acpAdapterWithHarness<{
      processes: Map<string, unknown>
      sessionProcesses: Map<string, string>
      store: { getAgentSessionId: (sessionId: string) => string | null }
    }>("openclaw")
    adapter.store = { getAgentSessionId: () => "agent_1" }
    adapter.sessionProcesses = new Map([["s1", "process-1"]])
    adapter.processes = new Map([["process-1", {
      key: "process-1",
      directory: "/work",
      proc: {
        alive: true,
        supportsForkSession: (agentSessionId?: string) => !agentSessionId || agentSessionId === "agent_1",
        goalCapabilities: () => ({ implemented: false, available: false, actions: [], optionalFields: [] }),
      },
      init: null,
      sessionIds: new Set(["s1"]),
    }]])

    expect(adapter.readHarnessCapabilities("/work").fork).toBe(true)
    expect(adapter.readHarnessCapabilities("/work", { sessionId: "s1" }).fork).toBe(true)
    expect(adapter.readHarnessCapabilities("/work", { sessionId: "missing" }).fork).toBe(false)
  })
})
