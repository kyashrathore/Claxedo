// target-layer: claxedo-ui/components - status-bar usage-limits popover.
// Shows remaining quota windows per installed harness (Claude 5h/weekly, Codex
// session/weekly, ...) from claxedo-server's /api/claxedo/usage-limits, which
// probes tokentracker-cli against the machine's local harness credentials.
import { Index, Show, Switch, Match, createMemo, createSignal, type JSX } from "solid-js"
import { useQuery, useQueryClient, keepPreviousData } from "@tanstack/solid-query"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { USAGE_LIMITS_QUERY_KEY, writeUsageLimitsSnapshot } from "./usage-limits-cache"
import {
  fetchUsageLimits,
  USAGE_PROVIDERS,
  USAGE_PROVIDER_LABELS,
  type UsageLimitsSnapshot,
  type UsageProvider,
  type UsageWindow,
} from "@/features/settings/data/usage-limits-api"
import "./usage-limits-popover.css"

type Bar = { label: string; percent: number; resetsAt: string | null }
type Entry = { name: string; label: string; provider: UsageProvider; bars: Bar[]; peak: number }

// tokentracker exposes utilization two ways: Claude windows carry `utilization`
// (0-100), Codex-style windows carry `used_percent`. Normalize to one number.
function windowPercent(w: UsageWindow | null | undefined): number | null {
  if (!w) return null
  const raw = typeof w.utilization === "number" ? w.utilization
    : typeof w.used_percent === "number" ? w.used_percent
    : null
  if (raw == null || !Number.isFinite(raw)) return null
  return Math.max(0, Math.min(100, Math.round(raw)))
}

// Providers disagree on the field name: Claude uses `resets_at`, Cursor `reset_at`.
function windowReset(w: UsageWindow | null | undefined): string | null {
  return (w?.resets_at as string | null) ?? (w?.reset_at as string | null) ?? null
}

function pushWindow(bars: Bar[], label: string, w: UsageWindow | null | undefined) {
  const percent = windowPercent(w)
  if (percent == null) return
  bars.push({ label, percent, resetsAt: windowReset(w) })
}

// Flatten a provider's known window slots into labelled bars. Provider payloads
// differ (Claude vs Codex vs the rest), so map the slots we know and fall back
// to any *_window object with a percent for the long tail.
function providerBars(key: string, p: UsageProvider): Bar[] {
  const bars: Bar[] = []
  if (key === "claude") {
    pushWindow(bars, "Session", p.five_hour)
    pushWindow(bars, "Weekly", p.seven_day)
    pushWindow(bars, "Weekly · Opus", p.seven_day_opus)
    for (const scoped of p.weekly_scoped ?? []) {
      bars.push({ label: scoped.label, percent: Math.max(0, Math.min(100, Math.round(scoped.utilization))), resetsAt: scoped.resets_at })
    }
    return bars
  }
  if (key === "codex") {
    pushWindow(bars, "Session", p.primary_window)
    pushWindow(bars, "Weekly", p.secondary_window)
    pushWindow(bars, "Credits", p.credit_window)
    return bars
  }
  for (const [field, value] of Object.entries(p)) {
    if (!field.endsWith("_window") || !value || typeof value !== "object") continue
    const w = value as UsageWindow
    const percent = windowPercent(w)
    if (percent == null) continue
    const label = w.label ?? field.replace(/_window$/, "").replace(/^\w/, (c) => c.toUpperCase())
    bars.push({ label, percent, resetsAt: windowReset(w) })
  }
  return bars
}

function formatReset(resetsAt: string | null): string | null {
  if (!resetsAt) return null
  const ms = Date.parse(resetsAt)
  if (!Number.isFinite(ms)) return null
  const diff = ms - Date.now()
  if (diff <= 0) return "resets now"
  const mins = Math.round(diff / 60000)
  if (mins < 60) return `${mins}m`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

function formatAge(updatedAt: number): string {
  const secs = Math.max(0, Math.round((Date.now() - updatedAt) / 1000))
  if (secs < 5) return "just now"
  if (secs < 60) return `${secs}s ago`
  const mins = Math.round(secs / 60)
  return `${mins}m ago`
}

// Severity by utilization: neutral until the quota is actually worth reacting
// to, amber approaching the cap, red once nearly exhausted. Returned as a state
// suffix so the bar fill and the percent numeral stay in lockstep (see the
// `.usage-fill.is-*` / `.usage-percent.is-*` pairs in the stylesheet).
function tone(percent: number): "" | " is-warning" | " is-critical" {
  if (percent >= 90) return " is-critical"
  if (percent >= 70) return " is-warning"
  return ""
}

function isProvider(v: UsageProvider | string): v is UsageProvider {
  return typeof v === "object" && v !== null
}

// A short, human status for a provider that has no renderable bars.
function issueStatus(p: UsageProvider): { dot: string; text: string } {
  if (p.auth_action_required === "reauth") return { dot: " is-warning", text: "Sign in again" }
  if (typeof p.retry_at === "string") {
    // This is a 429 on the provider's usage-*stats* endpoint (e.g. Anthropic's
    // oauth/usage), NOT the user's model quota — say so, so it doesn't read as
    // "your Claude is capped". The countdown is the stats endpoint's reset.
    const at = formatReset(p.retry_at)
    return { dot: " is-warning", text: at ? `Usage check throttled · retry ${at}` : "Usage check throttled" }
  }
  if (p.error) return { dot: " is-critical", text: p.error }
  return { dot: "", text: "No active limits" }
}

function UsageBar(props: { bar: Bar }): JSX.Element {
  const state = createMemo(() => tone(props.bar.percent))
  const reset = createMemo(() => formatReset(props.bar.resetsAt))
  // Width binds straight to the value; the transition animates when the number
  // changes on refresh. `@starting-style` gives a one-shot 0→value grow on first
  // paint without a mount signal (which was unreliable inside the portal).
  // A true 0 renders an empty track — the old 2% floor drew a sliver that read
  // as "barely started" when the real answer is "untouched".
  return (
    <div class="usage-window">
      <div class="flex items-baseline justify-between gap-2">
        <span class="text-12-regular usage-window-label">{props.bar.label}</span>
        <div class="flex items-baseline gap-1.5">
          <Show when={reset()}>
            <span class="usage-meta">resets {reset()}</span>
          </Show>
          <span class={`text-12-medium usage-percent${state()}`}>{props.bar.percent}%</span>
        </div>
      </div>
      <div class="usage-track">
        <div class={`usage-fill${state()}`} style={{ width: `${props.bar.percent}%` }} />
      </div>
    </div>
  )
}

// One provider = one disclosure. Collapsed it still answers "how consumed is
// this?" via the peak window's bar; expanded it lists every window. Only one is
// open at a time, so the panel's height stays roughly stable as you browse.
function ProviderCard(props: { entry: Entry; expanded: boolean; onToggle: () => void }): JSX.Element {
  const peakState = createMemo(() => tone(props.entry.peak))
  return (
    <div class="usage-provider" data-expanded={props.expanded ? "" : undefined}>
      <button
        type="button"
        class="usage-provider-summary"
        aria-expanded={props.expanded}
        onClick={props.onToggle}
      >
        <Icon name="chevron-right" size="small" class="usage-provider-chevron" />
        <span class="text-12-medium usage-provider-name">{props.entry.label}</span>
        <Show when={props.entry.provider.plan_label}>
          <span class="usage-meta usage-plan">{props.entry.provider.plan_label}</span>
        </Show>
        <span class="usage-provider-gap" />
        {/* aria-hidden: the expanded rows carry the same numbers with their
            window labels, so a screen reader would otherwise hear the peak
            twice with no way to tell which window it belonged to. */}
        <span class="usage-peak" aria-hidden="true">
          <span class="usage-track usage-peak-track">
            <span class={`usage-fill${peakState()}`} style={{ width: `${props.entry.peak}%` }} />
          </span>
          <span class={`text-12-medium usage-percent${peakState()}`}>{props.entry.peak}%</span>
        </span>
      </button>
      <div class="usage-provider-detail">
        <div>
          <Index each={props.entry.bars}>
            {(bar) => <UsageBar bar={bar()} />}
          </Index>
        </div>
      </div>
    </div>
  )
}

function SkeletonRow(): JSX.Element {
  return (
    <div class="usage-provider">
      <div class="usage-provider-summary">
        <div class="usage-skeleton h-3 w-20" />
        <span class="usage-provider-gap" />
        <div class="usage-skeleton h-[3px] w-10" />
      </div>
    </div>
  )
}

export function UsageLimitsPanel(): JSX.Element {
  // This panel only mounts while the account submenu is open, so the query is
  // enabled by mere presence — no `open` prop needed.
  // keepPreviousData paints the last snapshot instantly on reopen while a
  // background revalidation refreshes it (fixes the "stale until Refresh" flash).
  const query = useQuery(() => ({
    queryKey: USAGE_LIMITS_QUERY_KEY,
    queryFn: () => fetchUsageLimits(),
    refetchOnMount: true,
    refetchInterval: 60_000,
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  }))

  const partition = createMemo(() => {
    const data = query.data as UsageLimitsSnapshot | undefined
    const healthy: Entry[] = []
    const issues: Entry[] = []
    if (!data) return { healthy, issues }
    for (const name of USAGE_PROVIDERS) {
      const provider = data[name]
      if (!isProvider(provider) || !provider.configured) continue
      const label = USAGE_PROVIDER_LABELS[name] ?? name
      const bars = provider.error ? [] : providerBars(name, provider)
      const peak = bars.length > 0 ? Math.max(...bars.map((b) => b.percent)) : 0
      if (bars.length > 0) healthy.push({ name, label, provider, bars, peak })
      else issues.push({ name, label, provider, bars, peak })
    }
    // Most-consumed first — that's the row a user opened this to check.
    healthy.sort((a, b) => b.peak - a.peak)
    return { healthy, issues }
  })

  // Tri-state disclosure: `undefined` means untouched, so the default tracks the
  // data (the most-consumed provider opens itself). Once the user picks, their
  // choice sticks — including an explicit "all collapsed" (`null`), which a
  // plain `string | null` signal could not distinguish from untouched.
  const [choice, setChoice] = createSignal<string | null | undefined>(undefined)
  const expandedName = createMemo(() => {
    const picked = choice()
    if (picked !== undefined) return picked
    return partition().healthy[0]?.name ?? null
  })
  const toggle = (name: string) => setChoice(expandedName() === name ? null : name)

  const isFirstLoad = createMemo(() => query.isPending && !query.data)
  const total = createMemo(() => partition().healthy.length + partition().issues.length)

  // A plain refetch re-hits the server, but the server holds tokentracker's own
  // ~2min cache and returns the same snapshot — so the button felt dead. Force a
  // live re-probe (`refresh: true` → ?refresh=1 → resetUsageLimitsCache), and
  // hold the spinner ≥500ms so a fast, unchanged response still reads as "did
  // something". writeUsageLimitsSnapshot refreshes both the data and the age.
  const queryClient = useQueryClient()
  const [refreshing, setRefreshing] = createSignal(false)
  const doRefresh = async () => {
    if (refreshing()) return
    setRefreshing(true)
    const started = Date.now()
    try {
      const data = await fetchUsageLimits({ refresh: true })
      writeUsageLimitsSnapshot(queryClient, data)
    } catch {
      // Leave the last snapshot in place; the query's own error path is unaffected.
    }
    const elapsed = Date.now() - started
    if (elapsed < 500) await new Promise((r) => setTimeout(r, 500 - elapsed))
    setRefreshing(false)
  }
  const spinning = createMemo(() => refreshing() || query.isFetching)

  return (
    <div class="usage-panel">
      <div class="usage-head">
        <span class="text-12-medium usage-head-title">Usage limits</span>
        <DropdownMenu.Item
          aria-label="Refresh usage limits"
          closeOnSelect={false}
          class="usage-refresh"
          onSelect={() => void doRefresh()}
        >
          {/* Spin the wrapper, not the Icon: ClaxedoIcon forwards `class` through a
              dynamic-key classList that doesn't reliably react to a changing value. */}
          <span class="flex" classList={{ "animate-spin": spinning() }}>
            <Icon name="reload" size="small" />
          </span>
        </DropdownMenu.Item>
      </div>

      <div class="usage-body">
        <Switch>
          <Match when={isFirstLoad()}>
            <SkeletonRow />
            <SkeletonRow />
          </Match>
          <Match when={query.isError}>
            <div class="usage-empty">
              <Icon name="warning" size="small" class="text-icon-critical-base" />
              <span class="text-12-regular text-text-weak">{(query.error as Error)?.message ?? "Failed to load usage"}</span>
            </div>
          </Match>
          <Match when={total() === 0}>
            <div class="usage-empty">
              <Icon name="gauge" size="small" class="text-icon-weak-base" />
              <span class="text-12-regular text-text-weak">No signed-in harnesses</span>
              <span class="usage-meta">Log in to a coding agent on this machine to track its limits here.</span>
            </div>
          </Match>
          <Match when={total() > 0}>
            <Index each={partition().healthy}>
              {(entry) => (
                <ProviderCard
                  entry={entry()}
                  expanded={expandedName() === entry().name}
                  onToggle={() => toggle(entry().name)}
                />
              )}
            </Index>
          </Match>
        </Switch>
      </div>

      {/* Foot: failures fold behind a glyph and fan open on hover, so a panel
          about quotas is not dominated by the harnesses that have none. */}
      <Show when={query.data && !isFirstLoad()}>
        <div class="usage-foot" style={{ "--fan-count": partition().issues.length }}>
          <Show when={partition().issues.length > 0}>
            <div class="usage-issues">
              <button
                type="button"
                class="usage-issues-stack"
                aria-label={`${partition().issues.length} harnesses need attention`}
              >
                <Icon name="warning" size="small" />
                <span class="usage-meta usage-issues-count">{partition().issues.length}</span>
              </button>
              <div class="usage-issues-fan">
                <Index each={partition().issues}>
                  {(entry, i) => {
                    const status = createMemo(() => issueStatus(entry().provider))
                    return (
                      <div class="usage-issues-fan-row" style={{ "--fan-slot": i + 1 }}>
                        <span class={`usage-status-dot${status().dot}`} />
                        <span class="usage-meta usage-issues-fan-label">{entry().label}</span>
                        <span class="usage-meta">{status().text}</span>
                      </div>
                    )
                  }}
                </Index>
              </div>
            </div>
          </Show>
          <span class="usage-foot-gap" />
          <span class="usage-meta">{formatAge(query.dataUpdatedAt)}</span>
        </div>
      </Show>
    </div>
  )
}
