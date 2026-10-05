/// <reference types="bun" />
import { describe, expect, test } from "bun:test"
import type { QuotaAccount } from "./model"
import { groupQuotaAccounts, windowRisk } from "./quota-groups"

const account = (harness: string, patch: Partial<QuotaAccount> = {}): QuotaAccount => ({ harness, inUse: false, windows: [], ...patch })
const weekly = { window: "weekly", usedPercent: 40, resetsAt: null }

describe("groupQuotaAccounts", () => {
  test("puts the accounts in use first, then the other signed-in accounts, in the server's order", () => {
    const claude = account("claude", { label: "a@b.c", inUse: true, windows: [weekly] })
    const spare = account("claude", { label: "spare", credentialId: "c2" })
    const codex = account("codex", { machineLogin: true, inUse: true, windows: [weekly] })
    const groups = groupQuotaAccounts([claude, spare, codex])
    expect(groups.inUse).toEqual([claude, codex])
    expect(groups.signedIn).toEqual([spare])
    expect(groups.notConnected).toEqual([])
  })

  test("an installed agent that reports no plan is not connected, whatever its probe said", () => {
    const antigravity = account("antigravity", { otherAgent: true, label: "Antigravity", usageError: "Antigravity IDE is not running" })
    const grok = account("grok", { otherAgent: true, label: "Grok", usageError: "Grok API error: HTTP 403" })
    const kimi = account("kimi", { otherAgent: true, label: "Kimi" })
    const groups = groupQuotaAccounts([antigravity, grok, kimi])
    expect(groups.notConnected).toEqual([antigravity, grok, kimi])
    expect([...groups.inUse, ...groups.signedIn]).toEqual([])
  })

  test("an installed agent that reports a plan stays with the signed-in accounts", () => {
    const opencode = account("opencodeGo", { otherAgent: true, label: "OpenCode Go", windows: [weekly] })
    expect(groupQuotaAccounts([opencode]).signedIn).toEqual([opencode])
  })

  test("a signed-in account that cannot report its plan stays signed in", () => {
    const setupToken = account("claude", { credentialId: "c3", label: "contactyash", usageError: "Setup-tokens are inference-only" })
    const groups = groupQuotaAccounts([setupToken])
    expect(groups.signedIn).toEqual([setupToken])
    expect(groups.notConnected).toEqual([])
  })
})

describe("windowRisk", () => {
  test("colours only a window near or at its limit", () => {
    expect([0, 79, 79.4, 80, 99.6, 100, 130].map((usedPercent) => windowRisk({ window: "weekly", usedPercent, resetsAt: null }))).toEqual([
      "normal",
      "normal",
      "normal",
      "high",
      "reached",
      "reached",
      "reached",
    ])
  })
})
