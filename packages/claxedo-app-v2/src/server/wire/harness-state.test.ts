/// <reference types="bun" />
import { describe, expect, test } from "bun:test"
import { harnessStateFromWire, sessionConfigFromWire } from "./harness-state"

describe("harness state from the wire", () => {
  test("a folder's harness status", () => {
    expect(harnessStateFromWire({
      harness: { id: "codex", access: "native" },
      activeHarness: { kind: "connection", connectionId: "gw" },
      model: "gpt-5",
      modelProviderID: "codex",
      status: "applying",
      ready: false,
      harnessHealth: { status: "degraded", reason: "slow" },
      connectionState: { connectionId: "gw", state: "auth-required" },
    })).toEqual({
      type: { kind: "native", harnessId: "codex" },
      activeType: { kind: "connection", connectionId: "gw" },
      model: "gpt-5",
      modelProviderId: "codex",
      status: "applying",
      ready: false,
      harnessHealth: { status: "degraded", reason: "slow" },
      connectionState: { connectionId: "gw", state: "auth-required" },
    })
  })

  test("unknown statuses, health and connection states are dropped", () => {
    expect(harnessStateFromWire({ harness: { id: "nope", access: "native" }, status: "busy", harnessHealth: { status: "fine" }, connectionState: { connectionId: "gw", state: "odd" } })).toEqual({})
    expect(harnessStateFromWire("codex")).toBeUndefined()
  })

  test("a session's config names its harness, model and effort", () => {
    expect(sessionConfigFromWire({ harness: { id: "claude", access: "native" }, model: { providerID: "claude", modelID: "opus" }, variant: "high" })).toEqual({
      harness: { type: { kind: "native", harnessId: "claude" }, activeType: { kind: "native", harnessId: "claude" } },
      model: { modelId: "opus", providerId: "claude" },
      variant: "high",
    })
    expect(sessionConfigFromWire({ model: "opus" })).toEqual({ harness: {}, model: null })
  })
})
