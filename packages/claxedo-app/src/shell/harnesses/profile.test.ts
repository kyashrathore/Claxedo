import { describe, expect, test } from "bun:test"
import {
  canSelectHarnessForHost,
  compatibleHosts,
  requireCompatibleHarness,
  harnessProfileFromLegacy,
  type HarnessProfile,
} from "./profile"

const claudeCentral: HarnessProfile = {
  id: "runner_claude_sdk",
  kind: "claude-sdk",
  label: "Claude SDK",
  model: { providerID: "anthropic", modelID: "claude-sonnet" },
  credentialRef: "credential:anthropic",
  scope: "user",
}

describe("harness profiles", () => {
  test("derives compatible hosts from harness kind", () => {
    expect(compatibleHosts({ kind: "opencode" })).toEqual(["workspace"])
    expect(compatibleHosts({ kind: "codex-acp" })).toEqual(["workspace"])
    expect(compatibleHosts({ kind: "claude-sdk" })).toEqual(["central", "workspace"])
  })

  test("the formerly-missing kinds (cursor-sdk, pi) resolve to central+workspace", () => {
    // These two kinds were absent from HarnessKind before the vocabulary was
    // unified onto HarnessId. They are SDK/virtual harnesses (not sandbox-only),
    // so — like claude-sdk — they run centrally as well as in a workspace.
    expect(compatibleHosts({ kind: "cursor-sdk" })).toEqual(["central", "workspace"])
    expect(compatibleHosts({ kind: "pi" })).toEqual(["central", "workspace"])
    expect(canSelectHarnessForHost({ kind: "pi" }, "central")).toBe(true)
    expect(canSelectHarnessForHost({ kind: "cursor-sdk" }, "central")).toBe(true)
  })

  test("prevents opencode, codex, and ACP runners from central sessions", () => {
    const codex = harnessProfileFromLegacy({
      kind: "codex-acp",
      model: "gpt-5",
      workspaceId: "ws_1",
    })

    expect(canSelectHarnessForHost(codex, "central")).toBe(false)
    expect(canSelectHarnessForHost(codex, "workspace")).toBe(true)
    expect(() => requireCompatibleHarness(codex, "central"))
      .toThrow("codex-acp harness cannot be selected for central sessions")
  })

  test("keeps model and credential references as typed client data", () => {
    expect(claudeCentral).toEqual({
      id: "runner_claude_sdk",
      kind: "claude-sdk",
      label: "Claude SDK",
      model: { providerID: "anthropic", modelID: "claude-sonnet" },
      credentialRef: "credential:anthropic",
      scope: "user",
    })
  })

})
