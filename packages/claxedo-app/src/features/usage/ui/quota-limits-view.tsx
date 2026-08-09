import { For, Show, createMemo } from "solid-js"

type QuotaWindow = {
  label?: string
  utilization?: number
  used_percent?: number
  resets_at?: string | null
  reset_at?: string | null
}

type Bar = { label: string; percent: number; resetsAt: string | null }
type Provider = { name: string; plan?: string; issue?: string; windows: Bar[] }

const knownLabels: Record<string, string> = {
  five_hour: "Session",
  seven_day: "Weekly",
  seven_day_opus: "Weekly · Opus",
  primary_window: "Session",
  secondary_window: "Weekly",
  credit_window: "Credits",
}

function windowPercent(value: QuotaWindow) {
  const raw = typeof value.utilization === "number" ? value.utilization : value.used_percent
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined
  return Math.max(0, Math.min(100, Math.round(raw)))
}

function windowBar(field: string, raw: unknown): Bar | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return
  const value = raw as QuotaWindow
  const percent = windowPercent(value)
  if (percent === undefined) return
  return {
    label: value.label ?? knownLabels[field] ?? field.replace(/_window$/, "").replaceAll("_", " "),
    percent,
    resetsAt: value.resets_at ?? value.reset_at ?? null,
  }
}

function formatReset(value: string | null) {
  if (!value) return undefined
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return undefined
  const minutes = Math.max(0, Math.round((timestamp - Date.now()) / 60_000))
  if (minutes === 0) return "now"
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`
}

function issueStatus(provider: Record<string, unknown>) {
  if (provider.auth_action_required === "reauth") return "Sign in again"
  if (typeof provider.retry_at === "string") {
    const retry = formatReset(provider.retry_at)
    return retry ? `Usage check throttled · retry ${retry}` : "Usage check throttled"
  }
  return typeof provider.error === "string" ? provider.error : undefined
}

export function providerRows(snapshot: unknown): Provider[] {
  if (!snapshot || typeof snapshot !== "object") return []
  return Object.entries(snapshot as Record<string, unknown>).flatMap(([name, raw]) => {
    if (name === "fetched_at" || !raw || typeof raw !== "object" || Array.isArray(raw)) return []
    const provider = raw as Record<string, unknown>
    if (provider.configured !== true) return []
    const issue = issueStatus(provider)
    const windows = issue ? [] : Object.entries(provider).flatMap(([field, value]) => {
      if (field === "weekly_scoped" && Array.isArray(value)) {
        return value.flatMap((item) => {
          const bar = windowBar(field, item)
          return bar ? [bar] : []
        })
      }
      const bar = windowBar(field, value)
      return bar ? [bar] : []
    })
    return [{
      name,
      plan: typeof provider.plan_label === "string" ? provider.plan_label : undefined,
      issue: issue ?? (windows.length === 0 ? "No active limits" : undefined),
      windows,
    }]
  })
}

export function QuotaLimitsView(props: { status: string; snapshot?: unknown; error?: string }) {
  const providers = createMemo(() => providerRows(props.snapshot))
  return (
    <section class="usage-quota" aria-labelledby="usage-quota-title">
      <div class="usage-section-heading">
        <div><span class="usage-kicker">Live provider probes</span><h3 id="usage-quota-title">Quota windows</h3></div>
        <span class="usage-source-state" data-state={props.status}>{props.status}</span>
      </div>
      <Show when={providers().length} fallback={<div class="usage-chart-empty">{props.error ?? "No configured provider windows are available here."}</div>}>
        <div class="usage-quota-grid">
          <For each={providers()}>{(provider) => (
            <article class="usage-quota-provider">
              <header>
                <strong>{provider.name}</strong>
                <Show when={provider.plan}><span>{provider.plan}</span></Show>
                <Show when={provider.issue}><span>{provider.issue}</span></Show>
              </header>
              <For each={provider.windows}>{(window) => {
                const reset = createMemo(() => formatReset(window.resetsAt))
                return (
                  <div class="usage-quota-window">
                    <div>
                      <span>{window.label}</span>
                      <span><Show when={reset()}>resets {reset()} · </Show><b>{100 - window.percent}% left</b></span>
                    </div>
                    <progress max="100" value={window.percent} aria-label={`${provider.name} ${window.label}: ${window.percent}% used`} />
                  </div>
                )
              }}</For>
            </article>
          )}</For>
        </div>
      </Show>
    </section>
  )
}
