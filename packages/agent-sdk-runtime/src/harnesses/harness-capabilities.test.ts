import { describe, expect, test } from "bun:test"
import { getModel } from "@mariozechner/pi-ai"
import type { WithInternals } from "../test-utils/class-internals"
import { AcpHarnessAdapter } from "./acp/index"
import { ClaudeHarnessAdapter } from "./claude/index"
import { CodexHarnessAdapter } from "./codex/index"
import { CursorHarnessAdapter } from "./cursor/index"
import { OpenCodeHarnessAdapter } from "./opencode/index"
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
  options: { binary: string; harness: string }
  sessions: Map<string, unknown>
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
    options: { binary: "test-acp", harness },
    sessions: new Map(),
    probe: null,
  }
  Object.assign(adapter, defaults, { processes: defaults.sessions })
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

  test("OpenCode adapter reports a complete capability manifest", () => {
    const caps = new OpenCodeHarnessAdapter("http://127.0.0.1:4096").readHarnessCapabilities()
    expect(caps.harness).toBe("opencode")
    assertCompleteShape(caps)
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
    const adapters = [
      new OpenCodeHarnessAdapter("http://127.0.0.1:4096").readHarnessCapabilities(),
      ...(["claude", "codex", "cursor"] as const).map((type) => sdkAdapterWithDriver(type).readHarnessCapabilities()),
    ]
    expect(adapters.every((caps) => caps.subagents)).toBe(true)
    expect(acpAdapterWithHarness("openclaw").readHarnessCapabilities().subagents).toBe(false)
  })

  test("advertises Goal only when an adapter exposes the canonical resource", async () => {
    const unsupported = [
      acpAdapterWithHarness("openclaw").readHarnessCapabilities(),
      ...(["claude", "codex", "cursor"] as const).map((type) => sdkAdapterWithDriver(type).readHarnessCapabilities()),
    ]

    expect(unsupported.every((item) => item.goals === false)).toBe(true)
    expect(new OpenCodeHarnessAdapter("http://127.0.0.1:4096").readHarnessCapabilities().goals).toBe(true)
    expect((await new PiHarnessAdapter().readHarnessCapabilities(undefined)).goals).toBe(true)
  })

  test("bare and virtual-only Pi adapters do not advertise subagents", async () => {
    const bare = new PiHarnessAdapter()
    const session = await bare.createSession(undefined, "Virtual")

    const capabilities = await bare.readHarnessCapabilities(undefined, { sessionId: session.id })
    expect(capabilities.subagents).toBe(false)
    assertCompleteShape(capabilities)
  })

  test("model-backed Pi advertises subagents only with the configured tool-extension provider", async () => {
    const model = getModel("openai-codex", "gpt-5.1-codex-mini")
    const configured = new PiHarnessAdapter({
      modelBackend: () => ({
        model,
        getApiKey: () => "test-key",
        extraTools: [{ name: "subagent" } as never],
      }),
      toolExtensionProvider: { providesSubagentTool: () => true },
    })
    const withoutProvider = new PiHarnessAdapter({
      modelBackend: () => ({ model, getApiKey: () => "test-key" }),
    })
    const configuredSession = await configured.createSession(undefined, "Configured")
    const unconfiguredSession = await withoutProvider.createSession(undefined, "Unconfigured")
    const update = { model: { providerID: model.provider, modelID: model.id } }
    await configured.updateSessionConfig(configuredSession.id, update, undefined)
    await withoutProvider.updateSessionConfig(unconfiguredSession.id, update, undefined)

    expect((await configured.readHarnessCapabilities(undefined, { sessionId: configuredSession.id })).subagents).toBe(true)
    expect((await withoutProvider.readHarnessCapabilities(undefined, { sessionId: unconfiguredSession.id })).subagents).toBe(false)
  })

  test("configOptions is the cross-runtime way to declare ACP-only model probing", () => {
    // ACP harnesses surface dynamic config options (model picker, etc.).
    // OpenCode owns its own provider/model APIs and does not expose them
    // through the harness contract.
    const opencode = new OpenCodeHarnessAdapter("http://127.0.0.1:4096").readHarnessCapabilities()
    expect(opencode.configOptions).toBe(false)
    expect(acpAdapterWithHarness("openclaw").readHarnessCapabilities().configOptions).toBe(true)
  })

  test("revert/unrevert/commands are opencode-only today and ACP harnesses must declare that", () => {
    const opencode = new OpenCodeHarnessAdapter("http://127.0.0.1:4096").readHarnessCapabilities()
    expect(opencode.revert).toBe(true)
    expect(opencode.unrevert).toBe(true)
    expect(opencode.commands).toBe(true)
    const caps = acpAdapterWithHarness("openclaw").readHarnessCapabilities()
    expect(caps.revert).toBe(false)
    expect(caps.unrevert).toBe(false)
    expect(caps.commands).toBe(false)
  })

  test("OpenCode and ACP harnesses support baseline replay but do not advertise live reconnect", () => {
    const opencode = new OpenCodeHarnessAdapter("http://127.0.0.1:4096").readHarnessCapabilities()
    const acp = acpAdapterWithHarness("openclaw").readHarnessCapabilities()
    for (const caps of [opencode, acp]) {
      for (const key of ["abort", "replay", "permissions"] as const) expect(caps[key]).toBe(true)
      expect(caps.reconnect).toBe(false)
    }
    expect(opencode.todos).toBe(true)
    expect(acp.todos).toBe(false)
  })

  test("ACP fork is reported only for a live process that advertises session fork", () => {
    const adapter = acpAdapterWithHarness<{
      sessions: Map<string, unknown>
      sessionProcesses: Map<string, string>
      store: { getAgentSessionId: (sessionId: string) => string | null }
    }>("openclaw")
    adapter.store = { getAgentSessionId: () => "agent_1" }
    adapter.sessionProcesses = new Map([["s1", "s1"]])
    adapter.sessions.set("s1", {
      proc: {
        alive: true,
        supportsForkSession: (agentSessionId?: string) => !agentSessionId || agentSessionId === "agent_1",
        goalCapabilities: () => ({ implemented: false, available: false, actions: [], optionalFields: [] }),
      },
    })

    expect(adapter.readHarnessCapabilities("/work").fork).toBe(true)
    expect(adapter.readHarnessCapabilities("/work", { sessionId: "s1" }).fork).toBe(true)
    expect(adapter.readHarnessCapabilities("/work", { sessionId: "missing" }).fork).toBe(false)
  })
})
