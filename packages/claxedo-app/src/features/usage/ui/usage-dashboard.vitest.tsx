import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
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

afterEach(() => {
  cleanup()
  mocks.fetchUnifiedUsage.mockClear()
})

describe("UsageDashboard", () => {
  test("defaults to Total local usage, 7 days, and Tokens; compact switchers select one detail surface", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
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

  test("sends a distinct nonce for a manual refresh", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(() => (
      <QueryClientProvider client={client}>
        <UsageDashboard />
      </QueryClientProvider>
    ))
    await screen.findByRole("heading", { name: "By provider" })
    fireEvent.click(screen.getByRole("button", { name: "Refresh usage" }))
    await waitFor(() =>
      expect(mocks.fetchUnifiedUsage.mock.calls.some(([request]) => (request.refreshNonce ?? 0) > 0)).toBe(true),
    )
    const refreshed = mocks.fetchUnifiedUsage.mock.calls.find(([request]) => (request.refreshNonce ?? 0) > 0)?.[0]
    expect(refreshed?.refreshNonce).not.toBe(0)
  })

  test("requests the selected sort metric from the first breakdown page", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
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
