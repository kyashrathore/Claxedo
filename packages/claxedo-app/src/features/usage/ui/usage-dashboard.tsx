import { For, Show, createMemo, createSignal } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { unifiedUsageQuery } from "../data/usage-query"
import { type UnifiedUsageResponse, type UsageSeries } from "../data/usage-api"
import { UsageScopeSwitcher, type UsageView } from "./usage-scope-switcher"
import { UsageChart } from "./usage-chart"
import { UsageBreakdown } from "./usage-breakdown"
import { QuotaLimitsView } from "./quota-limits-view"
import { UsageBrandLabel, usageBrand } from "./usage-brand"
import "./usage-dashboard.css"

const empty = (): UsageSeries => ({
  totals: { turnCount: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, unknownCategories: 0 },
  daily: [],
})
const emptyCost = () => ({
  estimatedUsd: 0,
  pricedTokens: 0,
  unpricedTokens: 0,
  catalog: { adapter: "", version: "", source: "" },
  daily: [],
})

function totalTokens(series: UsageSeries) {
  const value = series.totals
  return value.input + value.output + value.reasoning + value.cacheRead + value.cacheWrite
}

function compact(value: number) {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 }).format(value)
}

function inclusiveLocalRange(days: number, now: number) {
  const since = new Date(now)
  since.setHours(0, 0, 0, 0)
  since.setDate(since.getDate() - (days - 1))
  const until = new Date(now)
  until.setHours(23, 59, 59, 999)
  return { since: since.getTime(), until: until.getTime() }
}

export function UsageDashboard() {
  const [selected, setSelected] = createSignal<UsageView>("claxedo")
  const [days, setDays] = createSignal(30)
  const [metric, setMetric] = createSignal<"tokens" | "cost">("tokens")
  const [attribution, setAttribution] = createSignal<"provider" | "model">("provider")
  const [cursor, setCursor] = createSignal<string>()
  const [previousCursors, setPreviousCursors] = createSignal<Array<string | undefined>>([])
  const [modelCursor, setModelCursor] = createSignal<string>()
  const [previousModelCursors, setPreviousModelCursors] = createSignal<Array<string | undefined>>([])
  const [refreshNonce, setRefreshNonce] = createSignal(0)
  const [until, setUntil] = createSignal(Date.now())
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  const range = createMemo(() => inclusiveLocalRange(days(), until()))
  const primaryGroup = () => "provider" as const
  const request = createMemo(() => ({
    since: range().since,
    until: range().until,
    timeZone,
    view: selected(),
    group: primaryGroup(),
    after: cursor(),
    modelAfter: modelCursor(),
    limit: 25,
    refreshNonce: refreshNonce(),
  }))
  const query = useQuery(() => unifiedUsageQuery(request()))
  const data = createMemo<UnifiedUsageResponse | undefined>(() => query.data)
  const claxedo = createMemo(
    () => data()?.claxedo ?? { ...empty(), cost: emptyCost(), status: "available" as const, scope: "local" as const },
  )
  const total = createMemo(() => data()?.total ?? empty())
  const activeSeries = createMemo(() => (selected() === "total" ? total() : claxedo()))
  const activeCost = createMemo(() => (selected() === "total" ? (data()?.totalCost ?? emptyCost()) : claxedo().cost))
  const activeTokens = createMemo(() => totalTokens(activeSeries()))
  const metricRows = createMemo(() => {
    const values = activeSeries().totals
    return [
      ["Processed", totalTokens(activeSeries())],
      ["Uncached input", values.input],
      ["Cached input", values.cacheRead],
      ["Output", values.output],
      ["Reasoning", values.reasoning],
      ["Turns", values.turnCount],
    ] as const
  })
  const resetPage = () => {
    setCursor(undefined)
    setPreviousCursors([])
    setModelCursor(undefined)
    setPreviousModelCursors([])
  }
  const changeRange = (next: number) => {
    setDays(next)
    setUntil(Date.now())
    setRefreshNonce(0)
    resetPage()
  }
  const selectView = (view: UsageView) => {
    setSelected(view)
    setAttribution("provider")
    setRefreshNonce(0)
    resetPage()
  }
  return (
    <div class="workspace-page-dashboard usage-dashboard">
      <header class="workspace-page-header usage-dashboard-header">
        <div class="workspace-page-title usage-dashboard-title">
          <h2>Usage</h2>
        </div>
        <div class="workspace-page-toolbar usage-top-switchers">
          <UsageScopeSwitcher selected={selected()} onSelect={selectView} />
          <div class="workspace-page-segmented usage-segmented" aria-label="Date range">
            <For each={[7, 30, 90]}>
              {(value) => (
                <button
                  type="button"
                  aria-pressed={(days() === value) == null ? undefined : days() === value ? "true" : "false"}
                  onClick={() => changeRange(value)}
                >
                  {value} days
                </button>
              )}
            </For>
          </div>
          <div class="workspace-page-segmented usage-segmented" aria-label="Metric">
            <button
              type="button"
              aria-pressed={(metric() === "tokens") == null ? undefined : metric() === "tokens" ? "true" : "false"}
              onClick={() => setMetric("tokens")}
            >
              Tokens
            </button>
            <button
              type="button"
              aria-pressed={(metric() === "cost") == null ? undefined : metric() === "cost" ? "true" : "false"}
              onClick={() => setMetric("cost")}
            >
              Cost
            </button>
          </div>
          <button
            type="button"
            class="workspace-page-refresh-button usage-refresh-button"
            aria-label="Refresh usage"
            disabled={query.isFetching}
            onClick={() => {
              setUntil(Date.now())
              setRefreshNonce(Date.now())
            }}
          >
            <Icon name="reload" size="small" class={{ "animate-spin": query.isFetching }} />
          </button>
        </div>
      </header>

      <Show when={selected() !== "quota" && data()} keyed>
        {(snapshot) => (
          <div class="workspace-page-notices usage-source-notices" aria-live="polite">
            <Show when={snapshot.claxedo.status !== "available" || snapshot.claxedo.scope === "local"}>
              <p>
                {snapshot.claxedo.error ??
                  (snapshot.claxedo.scope === "local"
                    ? "Local Claxedo usage is available. Sign in and reconnect to add cross-machine history."
                    : "Cross-machine usage is stale; the last valid snapshot remains visible.")}
              </p>
            </Show>
            <Show when={selected() === "total" && snapshot.externalLocal.status !== "available"}>
              <p>
                {snapshot.externalLocal.error ??
                  "Current-machine provider history is unavailable; Total local usage cannot be measured."}
              </p>
            </Show>
            <For
              each={
                selected() === "total"
                  ? snapshot.externalLocal.coverage.filter((source) => source.status !== "available")
                  : []
              }
            >
              {(source) => (
                <p>
                  {source.source}: {source.error ?? source.status}
                </p>
              )}
            </For>
          </div>
        )}
      </Show>

      <Show
        when={data()}
        fallback={
          <div class="usage-dashboard-loading" aria-live="polite">
            <i />
            <span>
              {query.isError
                ? `Usage unavailable · ${(query.error as Error).message}`
                : selected() === "total"
                  ? "Scanning local usage history…"
                  : selected() === "quota"
                    ? "Reading usage limits…"
                    : "Reading usage ledger…"}
            </span>
          </div>
        }
      >
        <Show
          when={selected() === "quota"}
          fallback={
            <>
              <div class="usage-overview-grid">
                <aside
                  class="usage-hero"
                  aria-label={metric() === "cost" ? "Estimated raw token cost" : "Processed tokens"}
                >
                  <span class="usage-kicker">{metric() === "cost" ? "Raw token cost" : "Processed tokens"}</span>
                  <strong class="usage-hero-value">
                    {metric() === "cost"
                      ? `$${activeCost().estimatedUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                      : compact(activeTokens())}
                  </strong>
                  <p>
                    {metric() === "cost"
                      ? "What these tokens would cost at API rates. Not what you were billed."
                      : "Provider-reported tokens in the selected range."}
                  </p>
                  <div class="usage-hero-attribution">
                    <For each={(data()?.breakdown?.rows ?? []).slice(0, 4)}>
                      {(row) => {
                        const rowTokens = () => row.input + row.output + row.reasoning + row.cacheRead + row.cacheWrite
                        const denominator = () => Math.max(1, activeTokens())
                        return (
                          <div class={`usage-hero-row usage-brand-row-${usageBrand(`${row.value} ${row.label}`)}`}>
                            <div>
                              <UsageBrandLabel value={row.value} label={row.label} />
                              <strong>
                                {metric() === "cost" ? `$${row.estimatedUsd.toFixed(2)}` : compact(rowTokens())}
                              </strong>
                            </div>
                            <div class="usage-hero-bar">
                              <i style={{ width: `${Math.min(100, (rowTokens() / denominator()) * 100)}%` }} />
                            </div>
                            <small>
                              {Math.round((rowTokens() / denominator()) * 1000) / 10}% of{" "}
                              {metric() === "cost" ? "reported tokens" : "tokens"}
                            </small>
                          </div>
                        )
                      }}
                    </For>
                  </div>
                </aside>
                <div class="usage-detail-main">
                  <UsageChart
                    series={activeSeries()}
                    chart={data()?.chart}
                    cost={activeCost()}
                    metric={metric()}
                    range={data()!.range}
                  />
                </div>
              </div>

              <div class="workspace-data-metric-strip usage-metric-strip" aria-label="Token category totals">
                <For each={metricRows()}>
                  {([label, value]) => (
                    <div>
                      <span>{label}</span>
                      <strong>{compact(value)}</strong>
                      <small>{value.toLocaleString()}</small>
                    </div>
                  )}
                </For>
              </div>

              <div class="usage-attribution-block">
                <div
                  class="workspace-page-segmented usage-attribution-switcher usage-segmented"
                  aria-label="Attribution"
                >
                  <button
                    type="button"
                    aria-pressed={
                      (attribution() === "provider") == null
                        ? undefined
                        : attribution() === "provider"
                          ? "true"
                          : "false"
                    }
                    onClick={() => setAttribution("provider")}
                  >
                    Provider
                  </button>
                  <button
                    type="button"
                    aria-pressed={
                      (attribution() === "model") == null ? undefined : attribution() === "model" ? "true" : "false"
                    }
                    onClick={() => setAttribution("model")}
                  >
                    Model
                  </button>
                </div>
                <Show
                  when={attribution() === "provider"}
                  fallback={
                    <UsageBreakdown
                      breakdown={data()?.modelBreakdown}
                      totals={activeSeries().totals}
                      group="model"
                      hasPrevious={previousModelCursors().length > 0}
                      busy={query.isFetching}
                      onNext={(next) => {
                        setPreviousModelCursors((values) => [...values, modelCursor()])
                        setModelCursor(next)
                      }}
                      onPrevious={() => {
                        const values = previousModelCursors()
                        setModelCursor(values.at(-1))
                        setPreviousModelCursors(values.slice(0, -1))
                      }}
                    />
                  }
                >
                  <UsageBreakdown
                    breakdown={data()?.breakdown}
                    totals={activeSeries().totals}
                    group="provider"
                    hasPrevious={previousCursors().length > 0}
                    busy={query.isFetching}
                    onNext={(next) => {
                      setPreviousCursors((values) => [...values, cursor()])
                      setCursor(next)
                    }}
                    onPrevious={() => {
                      const values = previousCursors()
                      setCursor(values.at(-1))
                      setPreviousCursors(values.slice(0, -1))
                    }}
                  />
                </Show>
              </div>
            </>
          }
        >
          <QuotaLimitsView
            status={data()?.quota.status ?? "unavailable"}
            snapshot={data()?.quota.snapshot}
            error={data()?.quota.error}
          />
        </Show>
      </Show>

      <Show when={selected() !== "quota"}>
        <footer class="usage-dashboard-footer">
          <span>{totalTokens(claxedo()).toLocaleString()} Claxedo tokens in range</span>
          <Show when={(data()?.externalLocal.unclassified ?? 0) > 0}>
            <span class="usage-coverage-warning">
              {data()!.externalLocal.unclassified} local events counted in Total without Claxedo ownership attribution.
            </span>
          </Show>
          <span>Missing token categories stay unknown; they are never filled with zero.</span>
        </footer>
      </Show>
    </div>
  )
}
