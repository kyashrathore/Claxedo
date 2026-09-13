import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { QuotaSnapshot } from "@claxedo/usage-contract"

// The card must read every word out of the dictionary, so the translator here
// echoes the key it was asked for: a sentence spelled into the markup instead
// would show up as itself and pass.
vi.mock("@/platform/i18n/provider", () => ({
  useLanguage: () => ({
    t: (key: string, vars?: Record<string, string>) => (vars ? `${key}:${Object.values(vars).join("|")}` : key),
    locale: () => "en",
  }),
}))

const { QuotaLimitsView, accountCards, quotaSummary } = await import("./quota-limits-view")

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
        { window: "session", usedPercent: 25, resetsAt: Date.now() + 3 * 3_600_000 + 60_000 },
        { window: "weekly_opus", usedPercent: 40, resetsAt: Date.now() + 4 * 86_400_000 + 60_000 },
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

async function renderView(props: Parameters<typeof QuotaLimitsView>[0]) {
  const result = render(() => <QuotaLimitsView {...props} />)
  await screen.findByRole("heading", { name: "usage.quota.title" })
  return result
}

describe("quota limits view", () => {
  test("two accounts on one harness are two cards under one heading", () => {
    const groups = accountCards(snapshot)
    expect(groups.map((group) => [group.name, group.cards.map((card) => card.label)])).toEqual([
      [{ text: "Claude Code" }, [{ text: "work@example.com" }, { text: "personal@example.com" }]],
      [{ text: "Codex" }, [{ key: "settings.providers.agents.machineLogin" }]],
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
      account: { text: "work@example.com" },
    })
    expect(quotaSummary(undefined)).toMatchObject({ accountCount: 0, remainingPercent: undefined })
  })

  test("names the account the summary is about only when a second card also has windows", () => {
    expect(quotaSummary({ accounts: [snapshot.accounts[0]] })).toMatchObject({ account: undefined })
    expect(quotaSummary({ accounts: [snapshot.accounts[0], snapshot.accounts[1]] }))
      .toMatchObject({ account: { text: "work@example.com" } })
  })

  test("draws a bar per window, dates the card once in its header, and marks the account the harness runs on", async () => {
    const { container } = await renderView({ snapshot })
    expect(screen.getByRole("progressbar", {
      name: "usage.quota.windowUsed:work@example.com|settings.providers.window.session|25",
    })).toHaveAttribute("value", "25")
    expect(screen.getByRole("progressbar", {
      name: "usage.quota.windowUsed:personal@example.com|settings.providers.window.session|90",
    })).toHaveAttribute("value", "90")
    expect(screen.getAllByText("usage.quota.inUse")).toHaveLength(2)
    expect(screen.getByText("usage.quota.kicker")).toBeInTheDocument()
    // The two windows of one card were read together; the age belongs to the
    // card, so it is said once, in the header, not under every bar.
    const card = container.querySelector('[data-account="cred_work"]')!
    expect(within(card as HTMLElement).getAllByText("1m")).toHaveLength(1)
    expect(card.querySelector("header .usage-quota-as-of")).not.toBeNull()
    // The column has room for the age; the sentence it stands for is the
    // element's name, and the same words are the tooltip.
    expect(card.querySelector('[data-component="usage-quota-as-of"]')?.getAttribute("aria-label"))
      .toBe("common.lastChecked:1 minute ago")
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
    expect(screen.getByRole("progressbar", {
      name: "usage.quota.windowUsed:work@example.com|settings.providers.window.session|73",
    })).toBeInTheDocument()
    expect(screen.getByText("usage.quota.windowLeft:27")).toBeInTheDocument()
    expect(screen.getByText("usage.quota.summary:27|settings.providers.window.session")).toBeInTheDocument()
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
    expect(places("cred_work")).toEqual([["monitor", "settings.providers.agents.reachLocal"]])
    expect(reach("cred_work")?.getAttribute("data-reach")).toBe("local-only")
    expect(places("codex-2")).toEqual([["monitor", "settings.providers.agents.reachLocal"]])
    expect(container.querySelector('[data-account="gemini-3"] [data-component="usage-quota-reach"]')).toBeNull()
  })

  test("the tab states no whole-read verdict of its own", async () => {
    const { container } = await renderView({ snapshot })
    expect(container.querySelector(".usage-source-state")).toBeNull()
    expect(screen.queryByText("available")).toBeNull()
  })

  test("the summary line names the constrained window, its account and when it comes back", async () => {
    await renderView({ snapshot })
    expect(screen.getByText(
      "usage.quota.summaryReset:usage.quota.summaryForAccount:60|settings.providers.window.weeklyOpus|work@example.com|3h",
    )).toBeInTheDocument()
  })

  test("the summary leaves the account unnamed when only one card carries windows", async () => {
    await renderView({ snapshot: { accounts: [snapshot.accounts[0]] } })
    expect(screen.getByText(
      "usage.quota.summaryReset:usage.quota.summary:60|settings.providers.window.weeklyOpus|3h",
    )).toBeInTheDocument()
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
    expect(screen.getByText("settings.providers.live.authFailed · usage.quota.reconnect")).toBeInTheDocument()
    expect(screen.queryByText("Sign in again")).toBeNull()
    expect(container.querySelector('[data-account="cred_dead"]')).toHaveAttribute("data-refused", "true")
    expect(screen.queryByRole("progressbar")).toBeNull()
    expect(screen.queryByRole("button", { name: "usage.quota.check" })).toBeNull()
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
    expect(screen.queryByRole("button", { name: "usage.quota.check" })).toBeNull()
  })

  test("an account nothing has read yet offers the check that would read it", async () => {
    const onCheck = vi.fn()
    await renderView({
      snapshot: {
        accounts: [{ harness: "cursor", credentialId: "cred_new", label: "c@example.com", inUse: true, windows: [] }],
      },
      onCheck,
    })
    expect(screen.getByText(/usage\.quota\.notChecked/)).toBeInTheDocument()
    const button = screen.getByRole("button", { name: "usage.quota.check" })
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
    const button = screen.getByRole("button", { name: "usage.quota.check" })
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
    expect(screen.getAllByRole("heading", { name: "usage.quota.otherAgents" })).toHaveLength(1)
    const section = screen.getByRole("region", { name: "usage.quota.otherAgents" })
    expect(within(section).getByText("Gemini CLI")).toBeInTheDocument()
    expect(within(section).getByText("GitHub Copilot")).toBeInTheDocument()
    expect(within(section).getByText("pro")).toBeInTheDocument()
    expect(within(section).getByRole("progressbar", {
      name: "usage.quota.windowUsed:Gemini CLI|settings.providers.window.session|30",
    })).toBeInTheDocument()
    expect(within(section).queryByText("usage.quota.inUse")).toBeNull()
    expect(within(section).queryByText(/usage\.quota\.reconnect/)).toBeNull()
  })

  test("an unavailable read shows the reason it was given, or that nothing reports a plan", async () => {
    const first = await renderView({ error: "registry offline" })
    expect(screen.getByText("registry offline")).toBeInTheDocument()
    first.unmount()
    await renderView({ snapshot: { accounts: [] } })
    expect(screen.getByText("usage.quota.empty")).toBeInTheDocument()
  })
})
