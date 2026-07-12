// target-layer: claxedo-ui/components - status-bar usage-limits popover.
// Shows remaining quota windows per installed harness (Claude 5h/weekly, Codex
// session/weekly, ...) from claxedo-server's /api/claxedo/usage-limits, which
// probes tokentracker-cli against the machine's local harness credentials.
import { Index, Show, Switch, Match, createMemo, createSignal, onMount, type JSX } from "solid-js"
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

type Bar = { label: string; percent: number; resetsAt: string | null }
type Entry = { name: string; label: string; provider: UsageProvider; bars: Bar[] }

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

// Severity colour by utilization — calm below 70, amber approaching the cap,
// red once nearly exhausted. Bar fill + the percent numeral share the tone.
function tone(percent: number): { fill: string; text: string } {
  if (percent >= 90) return { fill: "bg-icon-critical-base", text: "text-icon-critical-base" }
  if (percent >= 70) return { fill: "bg-icon-warning-base", text: "text-icon-warning-base" }
  return { fill: "bg-icon-success-base", text: "text-text-base" }
}

function isProvider(v: UsageProvider | string): v is UsageProvider {
  return typeof v === "object" && v !== null
}

// A short, human status for a provider that has no renderable bars.
function issueStatus(p: UsageProvider): { dot: string; text: string } {
  if (p.auth_action_required === "reauth") return { dot: "bg-icon-warning-base", text: "Sign in again" }
  if (typeof p.retry_at === "string") {
    // This is a 429 on the provider's usage-*stats* endpoint (e.g. Anthropic's
    // oauth/usage), NOT the user's model quota — say so, so it doesn't read as
    // "your Claude is capped". The countdown is the stats endpoint's reset.
    const at = formatReset(p.retry_at)
    return { dot: "bg-icon-warning-base", text: at ? `Usage check throttled · retry ${at}` : "Usage check throttled" }
  }
  if (p.error) return { dot: "bg-icon-critical-base", text: p.error }
  return { dot: "bg-icon-base/40", text: "No active limits" }
}

function UsageBar(props: { bar: Bar }): JSX.Element {
  const t = createMemo(() => tone(props.bar.percent))
  const reset = createMemo(() => formatReset(props.bar.resetsAt))
  // Width binds straight to the value; the transition animates when the number
  // changes on refresh. `@starting-style` gives a one-shot 0→value grow on first
  // paint without a mount signal (which was unreliable inside the portal).
  return (
    <div class="flex flex-col gap-1.5">
      <div class="flex items-baseline justify-between">
        <span class="text-xs text-text-weak">{props.bar.label}</span>
        <div class="flex items-baseline gap-1.5">
          <Show when={reset()}>
            <span class="text-2xs text-text-weaker">resets {reset()}</span>
          </Show>
          <span class={`text-xs font-semibold tabular-nums ${t().text}`}>{props.bar.percent}%</span>
        </div>
      </div>
      <div class="h-1.5 w-full rounded-full bg-surface-inset-base overflow-hidden">
        <div
          class={`usage-bar-fill h-full rounded-full ${t().fill}`}
          style={{ width: `${Math.max(props.bar.percent, 2)}%` }}
        />
      </div>
    </div>
  )
}

function ProviderCard(props: { entry: Entry; index: number }): JSX.Element {
  const [shown, setShown] = createSignal(false)
  onMount(() => requestAnimationFrame(() => setShown(true)))
  return (
    <div
      class="flex flex-col gap-2.5 py-3 transition-all duration-300 ease-out"
      style={{
        opacity: shown() ? "1" : "0",
        transform: shown() ? "translateY(0)" : "translateY(4px)",
        "transition-delay": `${props.index * 45}ms`,
      }}
    >
      <div class="flex items-center justify-between">
        <span class="text-sm font-medium text-text-base">{props.entry.label}</span>
        <Show when={props.entry.provider.plan_label}>
          <span class="rounded-full bg-surface-raised-base px-2 py-0.5 text-2xs uppercase tracking-wider text-text-weaker">
            {props.entry.provider.plan_label}
          </span>
        </Show>
      </div>
      <div class="flex flex-col gap-3">
        <Index each={props.entry.bars}>
          {(bar) => <UsageBar bar={bar()} />}
        </Index>
      </div>
    </div>
  )
}

function SkeletonRow(props: { delay: number }): JSX.Element {
  return (
    <div class="flex flex-col gap-2.5 py-3">
      <div class="h-3 w-20 rounded bg-surface-inset-base animate-pulse" style={{ "animation-delay": `${props.delay}ms` }} />
      <div class="h-1.5 w-full rounded-full bg-surface-inset-base animate-pulse" style={{ "animation-delay": `${props.delay + 80}ms` }} />
      <div class="h-1.5 w-full rounded-full bg-surface-inset-base animate-pulse" style={{ "animation-delay": `${props.delay + 160}ms` }} />
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
      if (bars.length > 0) healthy.push({ name, label, provider, bars })
      else issues.push({ name, label, provider, bars })
    }
    // Most-consumed first — that's the row a user opened this to check.
    healthy.sort((a, b) => Math.max(...b.bars.map((x) => x.percent)) - Math.max(...a.bars.map((x) => x.percent)))
    return { healthy, issues }
  })

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
    <div class="flex flex-col">
      <div class="flex items-center justify-between px-1 pb-2 mb-1 border-b border-border-weak-base/20">
        <div class="flex items-baseline gap-2">
          <span class="text-xs font-semibold text-text-base tracking-wide">Usage limits</span>
          <Show when={query.data && !isFirstLoad()}>
            <span class="text-2xs text-text-weaker">{formatAge(query.dataUpdatedAt)}</span>
          </Show>
        </div>
        <DropdownMenu.Item
          aria-label="Refresh usage limits"
          closeOnSelect={false}
          class="ml-auto !flex !h-5 !w-5 !p-0 items-center justify-center rounded text-icon-base transition-colors hover:text-text-base hover:bg-surface-base-hover active:scale-90"
          onSelect={() => void doRefresh()}
        >
          {/* Spin the wrapper, not the Icon: ClaxedoIcon forwards `class` through a
              dynamic-key classList that doesn't reliably react to a changing value. */}
          <span class="flex" classList={{ "animate-spin": spinning() }}>
            <Icon name="reload" size="small" />
          </span>
        </DropdownMenu.Item>
      </div>

      <Switch>
        <Match when={isFirstLoad()}>
          <div class="flex flex-col divide-y divide-border-weak-base/10 px-1">
            <SkeletonRow delay={0} />
            <SkeletonRow delay={120} />
          </div>
        </Match>
        <Match when={query.isError}>
          <div class="flex flex-col items-center gap-1 py-8 text-center">
            <Icon name="warning" size="small" class="text-icon-critical-base" />
            <span class="text-xs text-text-weak">{(query.error as Error)?.message ?? "Failed to load usage"}</span>
          </div>
        </Match>
        <Match when={total() === 0}>
          <div class="flex flex-col items-center gap-1.5 py-8 text-center">
            <Icon name="gauge" class="text-icon-base/50" />
            <span class="text-xs text-text-weak">No signed-in harnesses</span>
            <span class="text-2xs text-text-weaker px-4">Log in to a coding agent on this machine to track its limits here.</span>
          </div>
        </Match>
        <Match when={total() > 0}>
          <div class="px-1">
            <div class="flex flex-col divide-y divide-border-weak-base/10">
              <Index each={partition().healthy}>
                {(entry, i) => <ProviderCard entry={entry()} index={i} />}
              </Index>
            </div>
            <Show when={partition().issues.length > 0}>
              <div class="mt-1.5 pt-2 border-t border-border-weak-base/20">
                <span class="text-2xs uppercase tracking-wider text-text-weaker">Needs attention</span>
                <div class="mt-1.5 flex flex-col gap-1.5">
                  <Index each={partition().issues}>
                    {(entry) => {
                      const status = createMemo(() => issueStatus(entry().provider))
                      return (
                        <div class="flex items-center gap-2 py-0.5">
                          <span class={`h-1.5 w-1.5 shrink-0 rounded-full ${status().dot}`} />
                          <span class="text-xs text-text-weak shrink-0">{entry().label}</span>
                          <span class="text-2xs text-text-weaker truncate">{status().text}</span>
                        </div>
                      )
                    }}
                  </Index>
                </div>
              </div>
            </Show>
          </div>
        </Match>
      </Switch>
    </div>
  )
}
