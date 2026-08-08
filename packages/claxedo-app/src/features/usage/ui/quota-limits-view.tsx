import { For, Show, createMemo } from "solid-js"

type Window = { label?: string; utilization?: number; used_percent?: number; resets_at?: string | null; reset_at?: string | null }

function providerRows(snapshot: unknown) {
  if (!snapshot || typeof snapshot !== "object") return []
  return Object.entries(snapshot as Record<string, unknown>).flatMap(([name, raw]) => {
    if (name === "fetched_at" || !raw || typeof raw !== "object") return []
    const provider = raw as Record<string, unknown>
    if (provider.configured !== true) return []
    const windows = Object.entries(provider).flatMap(([field, value]) => {
      if (!value || typeof value !== "object") return []
      const window = value as Window
      const percent = typeof window.utilization === "number" ? window.utilization : window.used_percent
      return typeof percent === "number" ? [{ field, percent: Math.max(0, Math.min(100, percent)), reset: window.resets_at ?? window.reset_at }] : []
    })
    return [{ name, error: typeof provider.error === "string" ? provider.error : undefined, windows }]
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
              <header><strong>{provider.name}</strong><Show when={provider.error}><span>{provider.error}</span></Show></header>
              <For each={provider.windows}>{(window) => (
                <div class="usage-quota-window">
                  <div><span>{window.field.replaceAll("_", " ")}</span><b>{Math.round(100 - window.percent)}% left</b></div>
                  <progress max="100" value={window.percent} aria-label={`${provider.name} ${window.field}: ${Math.round(window.percent)}% used`} />
                </div>
              )}</For>
            </article>
          )}</For>
        </div>
      </Show>
    </section>
  )
}
