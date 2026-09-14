import { describe, expect, test } from "bun:test"
import { createMemoryRuntimeStore } from "../stores/memory"
import { harnessEffortLevels } from "../harness-effort"
import { sdkHarnessCapabilities } from "./shared/sdk-runtime-capabilities"
import type { WithInternals } from "../test-utils/class-internals"
import { AcpHarnessAdapter } from "./acp/index"
import { ClaudeHarnessAdapter } from "./claude/index"
import { CodexHarnessAdapter } from "./codex/index"
import { CursorHarnessAdapter } from "./cursor/index"
import { createClaudeSdkDriver } from "./claude/driver"
import { createCodexAppServerDriver } from "./codex/driver"
import { createCursorSdkDriver } from "./cursor/driver"
import type { SdkRuntimeDriver, SdkRuntimeDriverHost } from "./shared/sdk-runtime-driver"
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

/** The real driver, so the manifest reflects what each driver declares rather than a fixture's guess. */
function sdkDriver(type: "claude" | "codex" | "cursor"): SdkRuntimeDriver {
  const host = {
    lifecycle: () => ({ set() {}, delete() {}, get() {}, activeTurns: new Map() }),
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    bindSession() {},
  } as unknown as SdkRuntimeDriverHost
  if (type === "claude") return createClaudeSdkDriver(host)
  if (type === "cursor") return createCursorSdkDriver(host)
  return createCodexAppServerDriver(host)
}

function sdkAdapterWithDriver(type: "claude" | "codex" | "cursor") {
  const Adapter = type === "claude" ? ClaudeHarnessAdapter : type === "cursor" ? CursorHarnessAdapter : CodexHarnessAdapter
  const adapter = Object.create(Adapter.prototype) as WithInternals<(ClaudeHarnessAdapter | CodexHarnessAdapter | CursorHarnessAdapter), {
    driver: SdkRuntimeDriver
  }>
  adapter.driver = sdkDriver(type)
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

  test("SDK harnesses advertise only the interactions their driver raises", () => {
    // Cursor's SDK has no approval or question callback, so its driver never
    // fills the host's pending maps; Claude routes approvals and AskUserQuestion
    // through canUseTool; Codex raises both through app-server requests.
    expect(sdkAdapterWithDriver("cursor").readHarnessCapabilities()).toMatchObject({ permissions: false, questions: false })
    expect(sdkAdapterWithDriver("claude").readHarnessCapabilities()).toMatchObject({ permissions: true, questions: true })
    expect(sdkAdapterWithDriver("codex").readHarnessCapabilities()).toMatchObject({ permissions: true, questions: true })
  })

  test("native coding harnesses advertise subagents without assuming ACP extensions", () => {
    const adapters = (["claude", "codex", "cursor"] as const)
      .map((type) => sdkAdapterWithDriver(type).readHarnessCapabilities())
    expect(adapters.every((caps) => caps.subagents)).toBe(true)
    expect(acpAdapterWithHarness("openclaw").readHarnessCapabilities().subagents).toBe(false)
  })

  test("advertises Goal only when an adapter exposes the canonical resource", async () => {
    expect(acpAdapterWithHarness("openclaw").readHarnessCapabilities().goals).toBe(false)
    for (const type of ["claude", "codex", "cursor"] as const) {
      const driver = sdkDriver(type)
      expect(sdkAdapterWithDriver(type).readHarnessCapabilities().goals, type).toBe(!!driver.goals || !!driver.nativeGoal)
    }
    expect((await new PiHarnessAdapter({ store: createMemoryRuntimeStore() }).readHarnessCapabilities()).goals).toBe(true)
  })

  test("native Pi reports questions and goals but no permission or subagent emulation", () => {
    const adapter = new PiHarnessAdapter({ store: createMemoryRuntimeStore() })
    const caps = adapter.readHarnessCapabilities()
    assertCompleteShape(caps)
    expect(caps).toMatchObject({ harness: "pi", goals: true, subagents: false, permissions: false, questions: true, replay: true, configOptions: true })
  })

  test("only the harnesses with an effort control leave the unsupported catalog behind", () => {
    // Claude and Codex read per-model levels off a live catalog, so a cold
    // driver is unresolved, not unsupported; Cursor, Pi and ACP have no effort
    // control at all and say so.
    for (const type of ["claude", "codex"] as const) {
      expect(sdkAdapterWithDriver(type).readHarnessCapabilities().effortLevels, type)
        .toEqual({ status: "unresolved", models: [] })
    }
    expect(sdkAdapterWithDriver("cursor").readHarnessCapabilities().effortLevels)
      .toEqual({ status: "unsupported", models: [] })
    expect(new PiHarnessAdapter({ store: createMemoryRuntimeStore() }).readHarnessCapabilities().effortLevels)
      .toEqual({ status: "unsupported", models: [] })
    expect(acpAdapterWithHarness("openclaw").readHarnessCapabilities().effortLevels)
      .toEqual({ status: "unsupported", models: [] })
  })

  test("a resolved driver catalog reaches the capability response per model", () => {
    const driver = {
      ...sdkDriver("claude"),
      effortLevels: (directory?: string) => harnessEffortLevels(
        directory === "/work"
          ? [{ id: "opus", name: "Opus", supportsEffort: true, supportedEffortLevels: ["low", "max"] }]
          : [],
      ),
    }
    expect(sdkHarnessCapabilities(driver, "/work").effortLevels).toEqual({
      status: "resolved",
      models: [{ modelID: "opus", levels: ["low", "max"] }],
    })
    expect(sdkHarnessCapabilities(driver, "/elsewhere").effortLevels).toEqual({ status: "unresolved", models: [] })
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
