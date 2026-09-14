import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"

const clients = new Set<QueryClient>()
import { afterEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  fetchUnifiedUsage: vi.fn(async (_request?: { view?: string }) => ({
    version: 1 as const,
    range: { since: 0, until: 1, timeZone: "UTC" },
    quota: { status: "available" as const, snapshot: {} },
    claxedo: {
      totals: { turnCount: 2, input: 100, output: 20, reasoning: 5, cacheRead: 3, cacheWrite: 0, unknownCategories: 1 },
      daily: [],
      cost: {
        estimatedUsd: 0.12,
        pricedTokens: 128,
        unpricedTokens: 0,
        catalog: { adapter: "tokentracker", version: "0.75.1", source: "seed" },
      },
      status: "available" as const,
      scope: "cross-machine" as const,
    },
    externalLocal: {
      totals: { turnCount: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, unknownCategories: 0 },
      daily: [],
      cost: {
        estimatedUsd: 0,
        pricedTokens: 0,
        unpricedTokens: 0,
        catalog: { adapter: "tokentracker", version: "0.75.1", source: "seed" },
      },
      status: "available" as const,
      coverage: [],
      unclassified: 0,
    },
    total: {
      totals: { turnCount: 2, input: 100, output: 20, reasoning: 5, cacheRead: 3, cacheWrite: 0, unknownCategories: 1 },
      daily: [],
    },
    totalCost: {
      estimatedUsd: 0.12,
      pricedTokens: 128,
      unpricedTokens: 0,
      catalog: { adapter: "tokentracker", version: "0.75.1", source: "seed" },
    },
    breakdown: {
      dimension: "provider",
      rows: [
        {
          value: "openai",
          label: "OpenAI",
          turnCount: 2,
          input: 100,
          output: 20,
          reasoning: 5,
          cacheRead: 3,
          cacheWrite: 0,
          unknownCategories: 0,
          estimatedUsd: 0.12,
          pricedTokens: 128,
          unpricedTokens: 0,
          status: "final" as const,
        },
      ],
      next: "provider-next",
    },
    modelBreakdown: { dimension: "model", rows: [] },
    sync: { attempted: 0, delivered: 0, conflicts: 0, pending: 0 },
  })),
}))

vi.mock("../data/usage-api", async (original) => ({
  ...(await original<typeof import("../data/usage-api")>()),
  fetchUnifiedUsage: mocks.fetchUnifiedUsage,
}))

import { UsageDashboard } from "./usage-dashboard"
import { LanguageProvider } from "@/platform/i18n/provider"

afterEach(() => {
  cleanup()
  for (const client of clients) client.clear()
  clients.clear()
  mocks.fetchUnifiedUsage.mockClear()
})

describe("UsageDashboard", () => {
  test("defaults to Total local usage, 7 days, and Tokens; compact switchers select one detail surface", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.add(client)
    render(() => (
      <QueryClientProvider client={client}>
        <UsageDashboard />
      </QueryClientProvider>
    ))
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Total local usage" })).toHaveAttribute("aria-pressed", "true"),
    )
    expect(mocks.fetchUnifiedUsage.mock.calls.map(([request]) => request.view)).toEqual(["total"])
    expect(screen.getByRole("button", { name: "7 days" })).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("button", { name: "Tokens" })).toHaveAttribute("aria-pressed", "true")
    fireEvent.click(screen.getByRole("button", { name: "Usage limits" }))
    expect(screen.getByRole("button", { name: "Usage limits" })).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("button", { name: "Usage through Claxedo" })).toBeVisible()
    expect(screen.getByRole("button", { name: "Total local usage" })).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Total local usage" }))
    expect(screen.getByRole("button", { name: "Total local usage" })).toHaveAttribute("aria-pressed", "true")
    expect(screen.queryByText("Group by")).not.toBeInTheDocument()
    expect(await screen.findByRole("heading", { name: "By provider" })).toBeVisible()
    expect(screen.queryByRole("heading", { name: "By model" })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Model" }))
    expect(await screen.findByRole("heading", { name: "By model" })).toBeVisible()
    expect(screen.queryByRole("heading", { name: "By provider" })).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/Filter by/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Local ·/)).not.toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "Data quality" })).not.toBeInTheDocument()
    await waitFor(() =>
      expect(mocks.fetchUnifiedUsage.mock.calls.some(([request]) => request.view === "total")).toBe(true),
    )
    expect(mocks.fetchUnifiedUsage.mock.calls.some(([request]) => request.group === "model")).toBe(false)
    expect(mocks.fetchUnifiedUsage.mock.calls.some(([request]) => request.group === "provider")).toBe(true)
  })

  test("a throttled quota refresh reaches the Usage limits tab as a line naming the next read", async () => {
    const answer = mocks.fetchUnifiedUsage.getMockImplementation()!
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] })
    mocks.fetchUnifiedUsage.mockImplementation(async (request) => ({
      ...(await answer(request)),
      quota: {
        status: "available" as const,
        throttledUntil: Date.now() + 45_500,
        snapshot: {
          accounts: [{
            harness: "claude",
            credentialId: "cred_work",
            label: "work@example.com",
            inUse: true,
            windows: [{ window: "session", usedPercent: 25, resetsAt: null }],
            usageAt: Date.now() - 60_000,
          }],
        },
      },
    }))
    try {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      clients.add(client)
      const { container } = render(() => (
        <QueryClientProvider client={client}>
          <LanguageProvider locale="en">
            <UsageDashboard />
          </LanguageProvider>
        </QueryClientProvider>
      ))
      fireEvent.click(screen.getByRole("button", { name: "Usage limits" }))

      await waitFor(() =>
        expect(container.querySelector('[data-component="usage-quota-throttled"]')?.textContent)
          .toBe("Refreshed 1m ago · next refresh in 46s"),
      )
    } finally {
      vi.useRealTimers()
      mocks.fetchUnifiedUsage.mockImplementation(answer)
    }
  })

  test("sends a distinct nonce for a manual refresh", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.add(client)
    render(() => (
      <QueryClientProvider client={client}>
        <UsageDashboard />
      </QueryClientProvider>
    ))
    await screen.findByRole("heading", { name: "By provider" })
    const time = vi.spyOn(Date, "now").mockReturnValue(100_000)
    try {
      const refresh = screen.getByRole("button", { name: "Refresh usage" })
      await waitFor(() => expect(refresh).toBeEnabled())
      fireEvent.click(refresh)
      await waitFor(() => expect(mocks.fetchUnifiedUsage.mock.calls.some(([request]) => request.refreshNonce === 100_000)).toBe(true))
      await waitFor(() => expect(refresh).toBeEnabled())
      time.mockReturnValue(100_001)
      fireEvent.click(refresh)
      await waitFor(() => expect(mocks.fetchUnifiedUsage.mock.calls.some(([request]) => request.refreshNonce === 100_001)).toBe(true))
    } finally {
      time.mockRestore()
    }
  })

  test("requests the selected sort metric from the first breakdown page", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.add(client)
    render(() => (
      <QueryClientProvider client={client}>
        <UsageDashboard />
      </QueryClientProvider>
    ))
    await screen.findByRole("heading", { name: "By provider" })
    expect(mocks.fetchUnifiedUsage.mock.calls.at(-1)?.[0]).toMatchObject({ metric: "tokens", after: undefined })

    fireEvent.click(screen.getByRole("button", { name: "Next breakdown page" }))
    await waitFor(() =>
      expect(mocks.fetchUnifiedUsage.mock.calls.some(([request]) => request.after === "provider-next")).toBe(true),
    )
    fireEvent.click(screen.getByRole("button", { name: "Cost" }))
    await waitFor(() =>
      expect(mocks.fetchUnifiedUsage.mock.calls.at(-1)?.[0]).toMatchObject({ metric: "cost", after: undefined }),
    )
  })

  test("does not relabel Total data while a delayed Claxedo request is pending", async () => {
    const original = mocks.fetchUnifiedUsage.getMockImplementation()
    if (!original) throw new Error("missing usage fixture")
    let resolveClaxedo!: (value: Awaited<ReturnType<typeof original>>) => void
    const pendingClaxedo = new Promise<Awaited<ReturnType<typeof original>>>((resolve) => {
      resolveClaxedo = resolve
    })
    mocks.fetchUnifiedUsage.mockImplementation((request) =>
      request.view === "claxedo" ? pendingClaxedo : original(request),
    )
    try {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.add(client)
      render(() => (
        <QueryClientProvider client={client}>
          <UsageDashboard />
        </QueryClientProvider>
      ))
      await screen.findByRole("heading", { name: "By provider" })
      fireEvent.click(screen.getByRole("button", { name: "Usage through Claxedo" }))
      expect(await screen.findByText("Reading usage ledger…")).toBeVisible()
      expect(screen.queryByLabelText("Token category totals")).not.toBeInTheDocument()
      resolveClaxedo(await original({ view: "claxedo" }))
      expect(await screen.findByRole("heading", { name: "By provider" })).toBeVisible()
    } finally {
      mocks.fetchUnifiedUsage.mockImplementation(original)
    }
  })

  test("shows an unavailable state instead of zero-valued usage after an initial failure", async () => {
    mocks.fetchUnifiedUsage.mockRejectedValueOnce(new Error("scanner offline"))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.add(client)
    render(() => (
      <QueryClientProvider client={client}>
        <UsageDashboard />
      </QueryClientProvider>
    ))
    expect(await screen.findByText("Usage unavailable · scanner offline")).toBeVisible()
    expect(screen.getByRole("button", { name: "Total local usage" })).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("button", { name: "Total local usage" })).not.toHaveTextContent("—")
    expect(screen.queryByLabelText("Token category totals")).not.toBeInTheDocument()
  })
})
