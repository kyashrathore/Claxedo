import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, test } from "vitest"
import type { QuotaSnapshot } from "@claxedo/usage-contract"
import { QuotaLimitsView, accountCards, quotaSummary } from "./quota-limits-view"

afterEach(cleanup)

const snapshot: QuotaSnapshot = {
  accounts: [
    {
      harness: "claude",
      credentialId: "cred_work",
      label: "work@example.com",
      inUse: true,
      health: "ok",
      windows: [
        { window: "session", usedPercent: 25, resetsAt: Date.now() + 3 * 3_600_000 },
        { window: "weekly_opus", usedPercent: 40, resetsAt: Date.now() + 4 * 86_400_000 },
      ],
      usageAt: Date.now() - 60_000,
    },
    {
      harness: "claude",
      credentialId: "cred_personal",
      label: "personal@example.com",
      inUse: false,
      windows: [{ window: "session", usedPercent: 90, resetsAt: null }],
      usageAt: Date.now() - 60_000,
    },
    {
      harness: "codex",
      machineLogin: true,
      plan: "plus",
      inUse: true,
      windows: [{ window: "weekly", usedPercent: 10, resetsAt: null }],
      usageAt: 1,
    },
  ],
}

describe("quota limits view", () => {
  test("two accounts on one harness are two cards under one heading", () => {
    const groups = accountCards(snapshot)
    expect(groups.map((group) => [group.name, group.cards.map((card) => card.label)])).toEqual([
      ["Claude Code", ["work@example.com", "personal@example.com"]],
      ["Codex", ["This computer's login"]],
    ])
  })

  test("passes a window the vendor added since through under its own name", () => {
    const groups = accountCards({
      accounts: [{
        harness: "claude",
        credentialId: "c",
        inUse: false,
        windows: [{ window: "seven_day_sonnet", usedPercent: 12, resetsAt: null }],
      }],
    })
    expect(groups[0]?.cards[0]?.windows[0]?.label).toBe("seven day sonnet")
  })

  test("summarizes the tightest window across the accounts actually in use", () => {
    // The 90%-spent account is not in use, so it must not be what the line says.
    expect(quotaSummary(snapshot)).toMatchObject({
      accountCount: 2,
      constrainedLabel: "Weekly · Opus",
      remainingPercent: 60,
    })
    expect(quotaSummary(undefined)).toMatchObject({ accountCount: 0, remainingPercent: undefined })
  })

  test("draws a bar per window with its age, and marks the account the harness runs on", () => {
    render(() => <QuotaLimitsView status="available" snapshot={snapshot} />)
    expect(screen.getByRole("progressbar", { name: "work@example.com Session: 25% used" })).toHaveAttribute("value", "25")
    expect(screen.getByRole("progressbar", { name: "personal@example.com Session: 90% used" })).toHaveAttribute("value", "90")
    expect(screen.getAllByText("In use")).toHaveLength(2)
    expect(screen.getAllByText(/as of 1 minute ago/).length).toBeGreaterThan(0)
    expect(screen.getByText("From your connected accounts")).toBeInTheDocument()
  })

  test("a refused account shows the refusal and no bars", () => {
    render(() => <QuotaLimitsView status="degraded" snapshot={{
      accounts: [{
        harness: "claude",
        credentialId: "cred_dead",
        label: "revoked@example.com",
        inUse: false,
        health: "auth_failed",
        windows: [{ window: "session", usedPercent: 20, resetsAt: null }],
        usageAt: 1,
      }],
    }} />)
    expect(screen.getByText("Rejected by the provider")).toBeInTheDocument()
    expect(screen.queryByRole("progressbar")).toBeNull()
  })

  test("a Claude machine login says why it carries no windows, and any other account says it is unread", () => {
    render(() => <QuotaLimitsView status="degraded" snapshot={{
      accounts: [
        { harness: "claude", machineLogin: true, plan: "max", inUse: true, windows: [] },
        { harness: "cursor", credentialId: "cred_cursor", label: "c@example.com", inUse: true, windows: [] },
      ],
    }} />)
    expect(screen.getByText("Usage not readable for this login")).toBeInTheDocument()
    expect(screen.getByText("No plan usage has been read for this account")).toBeInTheDocument()
  })

  test("an unavailable read shows the reason it was given, or that nothing reports a plan", () => {
    const degraded = render(() => <QuotaLimitsView status="degraded" error="registry offline" />)
    expect(screen.getByText("registry offline")).toBeInTheDocument()
    degraded.unmount()
    render(() => <QuotaLimitsView status="unavailable" snapshot={{ accounts: [] }} />)
    expect(screen.getByText("No connected account reports a plan here.")).toBeInTheDocument()
  })
})
