import { describe, expect, test } from "bun:test"
import { AcpHarnessAdapter } from "./acp/index"
import { ClaudeHarnessAdapter } from "./claude/index"
import { CodexHarnessAdapter } from "./codex/index"
import { CursorHarnessAdapter } from "./cursor/index"
import { OpenCodeHarnessAdapter } from "./opencode/index"
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
]

function acpAdapterWithHarness(harness: "claude" | "codex" | "cursor") {
  const adapter = Object.create(AcpHarnessAdapter.prototype) as AcpHarnessAdapter & {
    options: { binary: string; harness: "claude" | "codex" | "cursor" }
    sessions: Map<string, unknown>
    probe: null
  }
  adapter.options = { binary: "test-acp", harness }
  adapter.sessions = new Map()
  adapter.probe = null
  return adapter
}

function sdkAdapterWithDriver(type: "claude" | "codex" | "cursor") {
  const Adapter = type === "claude" ? ClaudeHarnessAdapter : type === "cursor" ? CursorHarnessAdapter : CodexHarnessAdapter
  const adapter = Object.create(Adapter.prototype) as (ClaudeHarnessAdapter | CodexHarnessAdapter | CursorHarnessAdapter) & {
    driver: { type: "claude" | "codex" | "cursor" }
  }
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

  test("Claude ACP adapter reports a complete capability manifest", () => {
    const caps = acpAdapterWithHarness("claude").readHarnessCapabilities()
    expect(caps.harness).toBe("claude")
    assertCompleteShape(caps)
  })

  test("Codex ACP adapter reports a complete capability manifest", () => {
    const caps = acpAdapterWithHarness("codex").readHarnessCapabilities()
    expect(caps.harness).toBe("codex")
    assertCompleteShape(caps)
  })

  test("Cursor ACP adapter reports a complete capability manifest", () => {
    const caps = acpAdapterWithHarness("cursor").readHarnessCapabilities()
    expect(caps.harness).toBe("cursor")
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

  test("configOptions is the cross-runtime way to declare ACP-only model probing", () => {
    // ACP harnesses surface dynamic config options (model picker, etc.).
    // OpenCode owns its own provider/model APIs and does not expose them
    // through the harness contract.
    const opencode = new OpenCodeHarnessAdapter("http://127.0.0.1:4096").readHarnessCapabilities()
    expect(opencode.configOptions).toBe(false)
    for (const t of ["claude", "codex", "cursor"] as const) {
      expect(acpAdapterWithHarness(t).readHarnessCapabilities().configOptions).toBe(true)
    }
  })

  test("revert/unrevert/commands are opencode-only today and ACP harnesses must declare that", () => {
    const opencode = new OpenCodeHarnessAdapter("http://127.0.0.1:4096").readHarnessCapabilities()
    expect(opencode.revert).toBe(true)
    expect(opencode.unrevert).toBe(true)
    expect(opencode.commands).toBe(true)
    for (const t of ["claude", "codex", "cursor"] as const) {
      const caps = acpAdapterWithHarness(t).readHarnessCapabilities()
      expect(caps.revert).toBe(false)
      expect(caps.unrevert).toBe(false)
      expect(caps.commands).toBe(false)
    }
  })

  test("OpenCode and ACP harnesses support baseline replay but do not advertise live reconnect", () => {
    const sharedTrue: Array<keyof HarnessCapabilities> = ["abort", "replay", "permissions", "todos"]
    const adapters: HarnessCapabilities[] = [
      new OpenCodeHarnessAdapter("http://127.0.0.1:4096").readHarnessCapabilities(),
      acpAdapterWithHarness("claude").readHarnessCapabilities(),
      acpAdapterWithHarness("codex").readHarnessCapabilities(),
      acpAdapterWithHarness("cursor").readHarnessCapabilities(),
    ]
    for (const caps of adapters) {
      for (const key of sharedTrue) {
        expect(caps[key], `${caps.harness} must report ${key}=true`).toBe(true)
      }
      expect(caps.reconnect, `${caps.harness} must not claim live in-flight turn reattach`).toBe(false)
    }
  })

  test("ACP fork is reported only for a live process that advertises session fork", () => {
    const adapter = acpAdapterWithHarness("claude") as AcpHarnessAdapter & {
      sessions: Map<string, unknown>
      store: { getAgentSessionId: (sessionId: string) => string | null }
    }
    adapter.store = { getAgentSessionId: () => "agent_1" }
    adapter.sessions.set("s1", {
      proc: {
        alive: true,
        supportsForkSession: (agentSessionId?: string) => !agentSessionId || agentSessionId === "agent_1",
      },
    })

    expect(adapter.readHarnessCapabilities("/work").fork).toBe(true)
    expect(adapter.readHarnessCapabilities("/work", { sessionId: "s1" }).fork).toBe(true)
    expect(adapter.readHarnessCapabilities("/work", { sessionId: "missing" }).fork).toBe(false)
  })
})
