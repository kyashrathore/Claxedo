import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { afterEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({ fetchUnifiedUsage: vi.fn(async () => ({
  version: 1 as const,
  range: { since: 0, until: 1, timeZone: "UTC" },
  quota: { status: "available" as const, snapshot: {} },
  claxedo: {
    totals: { turnCount: 2, input: 100, output: 20, reasoning: 5, cacheRead: 3, cacheWrite: 0, unknownCategories: 1 }, daily: [],
    cost: { estimatedUsd: .12, pricedTokens: 128, unpricedTokens: 0, catalog: { adapter: "tokentracker", version: "0.75.1", source: "seed" } },
    status: "available" as const, scope: "cross-machine" as const,
  },
  externalLocal: {
    totals: { turnCount: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, unknownCategories: 0 }, daily: [], cost: { estimatedUsd: 0, pricedTokens: 0, unpricedTokens: 0, catalog: { adapter: "tokentracker", version: "0.75.1", source: "seed" } },
    status: "available" as const, coverage: [], unclassified: 0,
  },
  total: { totals: { turnCount: 2, input: 100, output: 20, reasoning: 5, cacheRead: 3, cacheWrite: 0, unknownCategories: 1 }, daily: [] },
  totalCost: { estimatedUsd: .12, pricedTokens: 128, unpricedTokens: 0, catalog: { adapter: "tokentracker", version: "0.75.1", source: "seed" } },
  sync: { attempted: 0, delivered: 0, conflicts: 0, pending: 0 },
})) }))

vi.mock("../data/usage-api", async (original) => ({ ...(await original<typeof import("../data/usage-api")>()), fetchUnifiedUsage: mocks.fetchUnifiedUsage }))

import { UsageDashboard } from "./usage-dashboard"

afterEach(() => { cleanup(); mocks.fetchUnifiedUsage.mockClear() })

describe("UsageDashboard", () => {
  test("defaults to Claxedo, 30 days, and Tokens; cards select one shared detail surface", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(() => <QueryClientProvider client={client}><UsageDashboard /></QueryClientProvider>)
    await waitFor(() => expect(screen.getByRole("button", { name: /Claxedo usage/ })).toHaveAttribute("aria-pressed", "true"))
    expect(screen.getByRole("button", { name: "30d" })).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("button", { name: "Tokens" })).toHaveAttribute("aria-pressed", "true")
    fireEvent.click(screen.getByRole("button", { name: /Total usage/ }))
    expect(screen.getByRole("button", { name: /Total usage/ })).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByLabelText("Group by")).toHaveValue("app")
  })
})
