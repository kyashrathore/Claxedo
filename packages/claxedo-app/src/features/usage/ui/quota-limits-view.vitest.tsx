import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { QuotaSnapshot } from "@claxedo/usage-contract"
import { LanguageProvider } from "@/platform/i18n/provider"
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

/** The view reads the dictionary, and the provider opens only once its store has loaded. */
async function renderView(props: Parameters<typeof QuotaLimitsView>[0]) {
  const result = render(() => (
    <LanguageProvider locale="en">
      <QuotaLimitsView {...props} />
    </LanguageProvider>
  ))
  await screen.findByRole("heading", { name: "Quota windows" })
  return result
}

describe("quota limits view", () => {
  test("two accounts on one harness are two cards under one heading", () => {
    const groups = accountCards(snapshot)
    expect(groups.map((group) => [group.name, group.cards.map((card) => card.label)])).toEqual([
      [{ text: "Claude Code" }, ["work@example.com", "personal@example.com"]],
      [{ text: "Codex" }, ["This computer's login"]],
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
    expect(groups[0]?.cards[0]?.windows[0]?.name).toEqual({ text: "seven day sonnet" })
  })

  test("summarizes the tightest window across the accounts actually in use", () => {
    // The 90%-spent account is not in use, so it must not be what the line says.
    expect(quotaSummary(snapshot)).toMatchObject({
      accountCount: 2,
      constrainedWindow: { key: "settings.providers.window.weeklyOpus" },
      remainingPercent: 60,
      account: "work@example.com",
    })
    expect(quotaSummary(undefined)).toMatchObject({ accountCount: 0, remainingPercent: undefined })
  })

  test("names the account the summary is about only when a second card also has windows", () => {
    expect(quotaSummary({ accounts: [snapshot.accounts[0]] })).toMatchObject({ account: undefined })
    expect(quotaSummary({ accounts: [snapshot.accounts[0], snapshot.accounts[1]] }))
      .toMatchObject({ account: "work@example.com" })
  })

  test("draws a bar per window, dates the card once in its header, and marks the account the harness runs on", async () => {
    const { container } = await renderView({ snapshot })
    expect(screen.getByRole("progressbar", { name: "work@example.com Session: 25% used" })).toHaveAttribute("value", "25")
    expect(screen.getByRole("progressbar", { name: "personal@example.com Session: 90% used" })).toHaveAttribute("value", "90")
    expect(screen.getAllByText("In use")).toHaveLength(2)
    expect(screen.getByText("From your connected accounts")).toBeInTheDocument()
    // The two windows of one card were read together; the age belongs to the
    // card, so it is said once, in the header, not under every bar.
    const card = container.querySelector('[data-account="cred_work"]')!
    expect(within(card as HTMLElement).getAllByText("1m")).toHaveLength(1)
    expect(card.querySelector("header .usage-quota-as-of")).not.toBeNull()
    // The column has room for the age; the sentence it stands for is the
    // element's name, and the same words are the tooltip.
    expect(card.querySelector('[data-component="usage-quota-as-of"]')?.getAttribute("aria-label"))
      .toBe("Last checked 1 minute ago")
  })

  test("a vendor's fraction of a percent reads as whole percent everywhere the card spells one", async () => {
    await renderView({ snapshot: {
      accounts: [{
        harness: "claude",
        credentialId: "cred_fraction",
        label: "work@example.com",
        inUse: true,
        windows: [{ window: "session", usedPercent: 72.68615984405457, resetsAt: null }],
      }],
    } })
    expect(screen.getByRole("progressbar", { name: "work@example.com Session: 73% used" })).toBeInTheDocument()
    expect(screen.getByText("27% left")).toBeInTheDocument()
    expect(screen.getByText("27% left on Session")).toBeInTheDocument()
  })

  test("a card claims no cloud reach the authority has not granted, and an agent Claxedo cannot run says nothing", async () => {
    const { container } = await renderView({ snapshot: {
      accounts: [
        ...snapshot.accounts,
        { harness: "gemini", otherAgent: true, label: "Gemini CLI", inUse: false, windows: [] },
      ],
    } })
    const reach = (key: string) =>
      container.querySelector(`[data-account="${key}"] [data-component="usage-quota-reach"]`)
    const places = (key: string) => [...reach(key)?.querySelectorAll("[data-icon]") ?? []]
      .map((icon) => [icon.getAttribute("data-icon"), icon.getAttribute("aria-label")])
    // A stored row is not a cloud-capable row: until the snapshot carries the
    // credential authority's own `deliverable`, no card may draw the cloud.
    expect(places("cred_work")).toEqual([["monitor", "This computer"]])
    expect(reach("cred_work")?.getAttribute("data-reach")).toBe("local-only")
    expect(places("codex-2")).toEqual([["monitor", "This computer"]])
    expect(container.querySelector('[data-account="gemini-3"] [data-component="usage-quota-reach"]')).toBeNull()
  })

  test("the tab states no whole-read verdict of its own", async () => {
    const { container } = await renderView({ snapshot })
    expect(container.querySelector(".usage-source-state")).toBeNull()
    expect(screen.queryByText("available")).toBeNull()
  })

  test("the summary line names the constrained window, its account and when it comes back", async () => {
    await renderView({ snapshot })
    expect(screen.getByText("60% left on Weekly · Opus for work@example.com, back in 3h")).toBeInTheDocument()
  })

  test("the summary leaves the account unnamed when only one card carries windows", async () => {
    await renderView({ snapshot: { accounts: [snapshot.accounts[0]] } })
    expect(screen.getByText("60% left on Weekly · Opus, back in 3h")).toBeInTheDocument()
  })

  test("a refused account says what to do about it, and shows no bars", async () => {
    // The failed usage read is downstream of the refusal, so it is not the news.
    const { container } = await renderView({ snapshot: {
      accounts: [{
        harness: "claude",
        credentialId: "cred_dead",
        label: "revoked@example.com",
        inUse: false,
        health: "auth_failed",
        windows: [{ window: "session", usedPercent: 20, resetsAt: null }],
        usageAt: 1,
        usageError: "Sign in again",
      }],
    } })
    expect(screen.getByText("Rejected by the provider · Reconnect in Settings")).toBeInTheDocument()
    expect(screen.queryByText("Sign in again")).toBeNull()
    expect(container.querySelector('[data-account="cred_dead"]')).toHaveAttribute("data-refused", "true")
    expect(screen.queryByRole("progressbar")).toBeNull()
    expect(screen.queryByRole("button", { name: "Check" })).toBeNull()
  })

  test("an account whose plan could not be read says why, in the reader's words", async () => {
    await renderView({ snapshot: {
      accounts: [{
        harness: "claude",
        credentialId: "cred_throttled",
        label: "work@example.com",
        inUse: true,
        windows: [],
        usageError: "Usage check throttled · retry 12m",
      }],
    } })
    expect(screen.getByText("Usage check throttled · retry 12m")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Check" })).toBeNull()
  })

  test("an account nothing has read yet offers the check that would read it", async () => {
    const onCheck = vi.fn()
    await renderView({
      snapshot: {
        accounts: [{ harness: "cursor", credentialId: "cred_new", label: "c@example.com", inUse: true, windows: [] }],
      },
      onCheck,
    })
    expect(screen.getByText(/Not checked yet/)).toBeInTheDocument()
    const button = screen.getByRole("button", { name: "Check" })
    expect(button).not.toBeDisabled()
    fireEvent.click(button)
    expect(onCheck).toHaveBeenCalledTimes(1)
  })

  test("the check is closed while a read is already running", async () => {
    const onCheck = vi.fn()
    await renderView({
      snapshot: {
        accounts: [{ harness: "cursor", credentialId: "cred_new", label: "c@example.com", inUse: true, windows: [] }],
      },
      onCheck,
      busy: true,
    })
    const button = screen.getByRole("button", { name: "Check" })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(onCheck).not.toHaveBeenCalled()
  })

  test("agents no turn can be sent to share one trailing section and are never in use", async () => {
    await renderView({ snapshot: {
      accounts: [
        { harness: "claude", credentialId: "cred_work", label: "work@example.com", inUse: true, windows: [] },
        {
          harness: "gemini",
          otherAgent: true,
          label: "Gemini CLI",
          plan: "pro",
          inUse: false,
          windows: [{ window: "session", usedPercent: 30, resetsAt: null }],
        },
        { harness: "copilot", otherAgent: true, label: "GitHub Copilot", inUse: false, windows: [] },
      ],
    } })
    expect(screen.getAllByRole("heading", { name: "Other agents on this machine" })).toHaveLength(1)
    const section = screen.getByRole("region", { name: "Other agents on this machine" })
    expect(within(section).getByText("Gemini CLI")).toBeInTheDocument()
    expect(within(section).getByText("GitHub Copilot")).toBeInTheDocument()
    expect(within(section).getByText("pro")).toBeInTheDocument()
    expect(within(section).getByRole("progressbar", { name: "Gemini CLI Session: 30% used" })).toBeInTheDocument()
    expect(within(section).queryByText("In use")).toBeNull()
    expect(within(section).queryByText(/Reconnect in Settings/)).toBeNull()
  })

  test("an unavailable read shows the reason it was given, or that nothing reports a plan", async () => {
    const first = await renderView({ error: "registry offline" })
    expect(screen.getByText("registry offline")).toBeInTheDocument()
    first.unmount()
    await renderView({ snapshot: { accounts: [] } })
    expect(screen.getByText("No connected account reports a plan here.")).toBeInTheDocument()
  })
})
