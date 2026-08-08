import { For, Show, createMemo, createSignal } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { unifiedUsageQuery, usageQueryKey } from "../data/usage-query"
import type { UnifiedUsageResponse, UsageSeries } from "../data/usage-api"
import { UsageSummaryCards, type UsageView } from "./usage-summary-cards"
import { UsageChart } from "./usage-chart"
import { UsageBreakdown } from "./usage-breakdown"
import { QuotaLimitsView } from "./quota-limits-view"
import "./usage-dashboard.css"

const DAY = 86_400_000
const empty = (): UsageSeries => ({
  totals: { turnCount: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, unknownCategories: 0 },
  daily: [],
})
const emptyCost = () => ({ estimatedUsd: 0, pricedTokens: 0, unpricedTokens: 0, catalog: { adapter: "", version: "", source: "" } })

function totalTokens(series: UsageSeries) {
  const value = series.totals
  return value.input + value.output + value.reasoning + value.cacheRead + value.cacheWrite
}

export function UsageDashboard() {
  const [selected, setSelected] = createSignal<UsageView>("claxedo")
  const [days, setDays] = createSignal(30)
  const [metric, setMetric] = createSignal<"tokens" | "cost">("tokens")
  const [group, setGroup] = createSignal("harness")
  const [refreshNonce, setRefreshNonce] = createSignal(0)
  const [until, setUntil] = createSignal(Date.now())
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  const request = createMemo(() => ({
    since: until() - days() * DAY,
    until: until(),
    timeZone,
    group: (selected() === "total" ? (group() === "harness" ? "app" : group()) : group()) as "harness" | "model" | "location" | "session" | "workspace" | "app",
    refreshNonce: refreshNonce(),
  }))
  const query = useQuery(() => unifiedUsageQuery(request()))
  const data = createMemo<UnifiedUsageResponse | undefined>(() => query.data)
  const claxedo = createMemo(() => data()?.claxedo ?? { ...empty(), cost: emptyCost(), status: "available" as const, scope: "local" as const })
  const total = createMemo(() => data()?.total ?? empty())
  const activeSeries = createMemo(() => selected() === "total" ? total() : claxedo())
  const activeCost = createMemo(() => selected() === "total" ? data()?.totalCost ?? emptyCost() : claxedo().cost)
  const categoryRows = createMemo(() => {
    const values = activeSeries().totals
    return [
      ["Input", values.input], ["Output", values.output], ["Reasoning", values.reasoning],
      ["Cache read", values.cacheRead], ["Cache write", values.cacheWrite],
    ] as const
  })
  const changeRange = (next: number) => {
    setDays(next)
    setUntil(Date.now())
  }
  const selectView = (view: UsageView) => {
    setSelected(view)
    if (view === "total" && group() === "harness") setGroup("app")
    if (view === "claxedo" && group() === "app") setGroup("harness")
  }
  return (
    <div class="usage-dashboard">
      <header class="usage-dashboard-header">
        <div>
          <span class="usage-kicker">Metering ledger</span>
          <h2>Usage</h2>
          <p>Provider-reported tokens across Claxedo, plus classified activity on this machine.</p>
        </div>
        <button
          type="button"
          class="usage-refresh-button"
          aria-label="Refresh usage"
          disabled={query.isFetching}
          onClick={() => { setUntil(Date.now()); setRefreshNonce((value) => value + 1) }}
        >
          <Icon name="reload" size="small" classList={{ "animate-spin": query.isFetching }} />
          <span>{query.isFetching ? "Refreshing" : "Refresh"}</span>
        </button>
      </header>

      <UsageSummaryCards
        selected={selected()}
        onSelect={selectView}
        claxedo={claxedo().totals}
        total={total().totals}
        claxedoCost={claxedo().cost}
        totalCost={data()?.totalCost ?? emptyCost()}
        quotaStatus={data()?.quota.status ?? "unavailable"}
        metric={metric()}
      />

      <div class="usage-toolbar" aria-label="Usage controls">
        <div class="usage-segmented" aria-label="Date range">
          <For each={[7, 30, 90]}>{(value) => (
            <button type="button" aria-pressed={days() === value} onClick={() => changeRange(value)}>{value}d</button>
          )}</For>
        </div>
        <Show when={selected() !== "quota"}>
          <div class="usage-segmented" aria-label="Metric">
            <button type="button" aria-pressed={metric() === "tokens"} onClick={() => setMetric("tokens")}>Tokens</button>
            <button type="button" aria-pressed={metric() === "cost"} onClick={() => setMetric("cost")}>Est. cost</button>
          </div>
          <label class="usage-group-control">
            <span>Group by</span>
            <select value={group()} onChange={(event) => setGroup(event.currentTarget.value)}>
              <For each={selected() === "total" ? ["app", "model"] : ["harness", "model", "location", "session", "workspace"]}>
                {(value) => <option value={value}>{value[0]!.toUpperCase() + value.slice(1)}</option>}
              </For>
            </select>
          </label>
        </Show>
        <span class="usage-updated" aria-live="polite">
          {query.isError ? `Refresh failed · ${(query.error as Error).message}` : data() ? `${data()!.claxedo.scope === "cross-machine" ? "Synced" : "Local"} · ${timeZone}` : "Loading ledger…"}
        </span>
      </div>

      <Show when={!query.isPending || data()} fallback={<div class="usage-dashboard-loading" aria-live="polite"><i /><span>Reading usage ledger…</span></div>}>
        <Show when={selected() === "quota"} fallback={
          <div class="usage-detail-grid">
            <div class="usage-detail-main">
              <div class="usage-metric-strip" aria-label="Token category totals">
                <For each={categoryRows()}>{([label, value]) => (
                  <div><span>{label}</span><strong>{metric() === "tokens" ? value.toLocaleString() : "—"}</strong></div>
                )}</For>
              </div>
              <Show when={metric() === "tokens"} fallback={
                <section class="usage-cost-panel" aria-label="Estimated API cost">
                  <span class="usage-kicker">Projection, not an invoice</span>
                  <strong>${activeCost().estimatedUsd.toFixed(4)}</strong>
                  <p>{activeCost().pricedTokens.toLocaleString()} priced tokens · {activeCost().unpricedTokens.toLocaleString()} unpriced</p>
                  <small>Catalog {activeCost().catalog.version || "unavailable"} · {activeCost().catalog.source || "no pricing source"}</small>
                </section>
              }>
                <UsageChart series={activeSeries()} metric="tokens" />
              </Show>
            </div>
            <UsageBreakdown breakdown={data()?.breakdown} totals={activeSeries().totals} group={request().group} />
          </div>
        }>
          <QuotaLimitsView status={data()?.quota.status ?? "unavailable"} snapshot={data()?.quota.snapshot} error={data()?.quota.error} />
        </Show>
      </Show>

      <footer class="usage-dashboard-footer">
        <span>{totalTokens(claxedo()).toLocaleString()} Claxedo tokens in range</span>
        <Show when={(data()?.externalLocal.unclassified ?? 0) > 0}>
          <span class="usage-coverage-warning">{data()!.externalLocal.unclassified} local events quarantined: provenance could not be proven.</span>
        </Show>
        <span>Missing token categories stay unknown; they are never filled with zero.</span>
      </footer>
    </div>
  )
}
