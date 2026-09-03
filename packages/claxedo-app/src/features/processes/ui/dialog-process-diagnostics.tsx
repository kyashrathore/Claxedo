import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"

import type { LocalDiagnostics } from "../data/local-diagnostics"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { buildDiagnosticsModel, ownerGroup } from "./diagnostics/model"
import { DiagnosticsTimeline, formatTime } from "./diagnostics/timeline"

const TABS = [
  { id: "activity", label: "Activity" },
  { id: "sessions", label: "Session memory" },
  { id: "processes", label: "Processes" },
] as const
type TabId = (typeof TABS)[number]["id"]

export function DialogProcessDiagnostics(props: { warmSessions?: () => LocalDiagnostics.WarmSessionMemory[] }) {
  const dialog = useDialog()
  const capability = usePlatform().processDiagnostics
  const [snapshot, setSnapshot] = createSignal<LocalDiagnostics.RetainedSnapshot>()
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string>()
  const [disconnected, setDisconnected] = createSignal(false)
  const [expanded, setExpanded] = createSignal<Record<string, boolean>>({})
  const [busy, setBusy] = createSignal<string>()
  const [sessionScan, setSessionScan] = createSignal<LocalDiagnostics.SessionMemoryScanResult>()
  const [sessionScanBusy, setSessionScanBusy] = createSignal(false)
  const [sessionScanError, setSessionScanError] = createSignal<string>()
  const [tab, setTab] = createSignal<TabId>("activity")
  const [sessionsShown, setSessionsShown] = createSignal(10)
  const [announcement, setAnnouncement] = createSignal("")
  let lastReceivedAt = Date.now()
  let unsubscribe: (() => void) | undefined
  let watchdog: ReturnType<typeof setTimeout> | undefined
  let reconnect: ReturnType<typeof setTimeout> | undefined
  let reconnectAttempt = 0
  let disposed = false

  const accept = (next: LocalDiagnostics.RetainedSnapshot) => {
    if (disposed) return
    const transition = sourceTransition(snapshot()?.sources, next.sources)
    if (transition) setAnnouncement(transition)
    setSnapshot(next)
    lastReceivedAt = Date.now()
    setDisconnected(false)
    setError(undefined)
    setLoading(false)
    reconnectAttempt = 0
    armWatchdog()
  }

  const load = async () => {
    if (!capability) {
      setError("This device's diagnostics are available only in the Claxedo desktop app.")
      setLoading(false)
      return
    }
    if (!snapshot()) setLoading(true)
    try {
      accept(await capability.getSnapshot())
      connect()
    } catch (cause) {
      setError(message(cause))
      setLoading(false)
    }
  }

  const connect = () => {
    if (!capability || disposed) return
    unsubscribe?.()
    unsubscribe = undefined
    try {
      unsubscribe = capability.subscribe(accept)
      armWatchdog()
    } catch {
      markDisconnected()
    }
  }

  const armWatchdog = () => {
    if (watchdog) clearTimeout(watchdog)
    watchdog = setTimeout(() => {
      if (Date.now() - lastReceivedAt < 7_000) {
        armWatchdog()
        return
      }
      markDisconnected()
    }, 7_000)
  }

  const markDisconnected = () => {
    if (disposed) return
    setDisconnected(true)
    unsubscribe?.()
    unsubscribe = undefined
    if (reconnect) clearTimeout(reconnect)
    const delay = Math.min(10_000, 500 * 2 ** reconnectAttempt++)
    reconnect = setTimeout(connect, delay)
  }

  onMount(() => void load())
  onCleanup(() => {
    disposed = true
    unsubscribe?.()
    if (watchdog) clearTimeout(watchdog)
    if (reconnect) clearTimeout(reconnect)
  })

  const model = createMemo(() => {
    const current = snapshot()
    return current ? buildDiagnosticsModel(current) : undefined
  })
  const grouped = createMemo(() => [
    ...Map.groupBy(model()?.contributors ?? [], (contributor) => ownerGroup(contributor.owner.kind)).entries(),
  ])
  const current = createMemo(() => model()?.series.at(-1))
  const peakCpu = createMemo(() =>
    Math.max(0, ...(model()?.series.flatMap((point) => (point.cpu === undefined ? [] : [point.cpu])) ?? [])),
  )
  const peakMemoryImpact = createMemo(() =>
    model()?.series.reduce<ReturnType<typeof current>>(
      (peak, point) =>
        point.memoryImpactBytes !== undefined &&
        (peak?.memoryImpactBytes === undefined || point.memoryImpactBytes > peak.memoryImpactBytes)
          ? point
          : peak,
      undefined,
    ),
  )
  const memoryImpactLabel = createMemo(() => {
    const kinds = model()?.memoryImpactKinds ?? []
    if (kinds.length === 0) return "Memory impact"
    return kinds
      .map(
        (kind) =>
          ({
            "physical-footprint": "macOS footprint",
            "private-working-set": "private working set",
            pss: "proportional set size",
            "rss-fallback": "RSS fallback",
          })[kind],
      )
      .join(" + ")
  })
  const sessions = createMemo(() => {
    const scan = sessionScan()
    if (!scan) return []
    const warm = new Map(scan.warmSessions.map((session) => [session.sessionId, session]))
    const rows = scan.sessions.map((session) => ({
      sessionId: session.sessionId,
      label: session.title ?? session.sessionId,
      detail: `${session.harness}${session.profile ? ` · ${session.profile}` : ""}`,
      buckets: session.buckets,
      warm: warm.get(session.sessionId),
    }))
    // A conversation can be warm before it is ever written back, so warm-only
    // sessions still get a row — measured from the renderer's own estimate.
    const stored = new Set(rows.map((row) => row.sessionId))
    const warmOnly = scan.warmSessions
      .filter((session) => !stored.has(session.sessionId))
      .map((session) => ({
        sessionId: session.sessionId,
        label: session.sessionId,
        detail: "not yet written to a store",
        buckets: session.buckets,
        warm: session,
      }))
    return [...rows, ...warmOnly].sort((left, right) => right.buckets.totalBytes - left.buckets.totalBytes)
  })
  const degradedSources = createMemo(() => (snapshot()?.sources ?? []).filter((source) => source.state !== "healthy"))

  const scanSessions = async () => {
    if (!capability || sessionScanBusy()) return
    setSessionScanBusy(true)
    setSessionScanError(undefined)
    try {
      const result = await capability.scanSessionMemory({ warmSessions: props.warmSessions?.() ?? [] })
      setSessionScan(result)
      setSessionsShown(10)
      setAnnouncement(
        `Session memory scan complete. ${result.sessions.length} stored sessions and ${result.warmSessions.length} warm sessions analyzed.`,
      )
    } catch (cause) {
      setSessionScanError(message(cause))
      setAnnouncement(`Session memory scan failed: ${message(cause)}.`)
    } finally {
      setSessionScanBusy(false)
    }
  }

  const act = async (ownerId: string, action: LocalDiagnostics.ActionKind, grant: LocalDiagnostics.ActionGrant) => {
    if (!capability) return
    const key = `${ownerId}:${action}`
    setBusy(key)
    try {
      const result =
        action === "stop"
          ? await capability.stop({ action: "stop", token: grant.token })
          : await capability.kill({ action: "kill", token: grant.token })
      setAnnouncement(
        result.ok
          ? `${action === "stop" ? "Stopped" : "Killed"} the selected local owner.`
          : `${action === "stop" ? "Stop" : "Kill"} was not completed: ${result.code}.`,
      )
      accept(await capability.getSnapshot())
    } catch (cause) {
      setAnnouncement(`${action === "stop" ? "Stop" : "Kill"} failed: ${message(cause)}.`)
    } finally {
      setBusy(undefined)
    }
  }
  return (
    <Dialog
      size="x-large"
      transition
      flush
      class="flex-1 workspace-page-dialog workspace-page-dialog-shell settings-dialog-shell usage-dialog-shell claxedo-diagnostics-dialog"
      aria-label="This device diagnostics"
      onEscapeKeyDown={() => dialog.close()}
    >
      <div class="workspace-page-mobile-header usage-dialog-mobile-header">
        <span>This device</span>
        <button type="button" aria-label="Close diagnostics" onClick={() => dialog.close()}>
          <Icon name="close" size="small" />
        </button>
      </div>
      <div class="workspace-page-dashboard usage-dashboard claxedo-diagnostics-dashboard">
        <header class="workspace-page-header usage-dashboard-header">
          {/* Scoped to the machine this app window runs on, and named as
              such. The numbers below come from the desktop process itself
              (`usePlatform().processDiagnostics`), so they describe THIS
              device whatever workspace is focused — a cloud sandbox or a
              teammate's host has its own processes and its own memory, and
              this dialog has never been able to see them. */}
          <div class="workspace-page-title usage-dashboard-title">
            <h2>This device</h2>
            <p class="text-xs text-text-weak">
              Processes and memory on the machine running this app. Cloud and teammate-hosted
              workspaces run elsewhere and are not measured here.
            </p>
          </div>
          <div class="workspace-page-toolbar claxedo-diagnostics-toolbar">
            <div
              role="group"
              aria-label="Diagnostics sections"
              class="workspace-page-segmented usage-segmented claxedo-diagnostics-tabs"
            >
              <For each={TABS}>
                {(entry) => (
                  <button
                    type="button"
                    id={`diagnostics-tab-${entry.id}`}
                    aria-pressed={tab() === entry.id}
                    aria-controls={`diagnostics-panel-${entry.id}`}
                    onClick={() => setTab(entry.id)}
                  >
                    {entry.label}
                  </button>
                )}
              </For>
            </div>
            <button
              type="button"
              class="workspace-page-refresh-button"
              aria-label="Refresh diagnostics"
              disabled={loading()}
              onClick={() => void load()}
            >
              <Icon name="reload" size="small" classList={{ "animate-spin": loading() }} />
            </button>
          </div>
        </header>

        <div class="workspace-page-notices">
          <p class="flex items-center gap-2">
            <span
              class={`inline-block h-2 w-2 rounded-full ${
                error() || disconnected() ? "bg-icon-warning-base" : "bg-icon-success-base"
              }`}
            />
            <span>
              {error() ? "Collector unavailable" : disconnected() ? "Collector disconnected" : "Collector active"}
            </span>
          </p>
          <Show when={snapshot()}>
            {(value) => (
              <p>
                History starts {formatTime(value().retainedFromAt)} · last sample {formatTime(value().capturedAt)}
                {value().retention.state === "truncated" ? " · retained history is memory-limited" : ""}
                <Show when={degradedSources().length > 0}>
                  <span data-testid="diagnostics-source-health" data-degraded={degradedSources().length}>
                    {" · "}
                    {degradedSources()
                      .map((source) => `${source.source} ${source.state}`)
                      .join(", ")}
                  </span>
                </Show>
              </p>
            )}
          </Show>
        </div>

        <Show when={error()}>
          {(value) => (
            <div
              role="alert"
              class="rounded-md border border-border-critical-base bg-surface-critical-base/10 px-3 py-2 text-sm text-text-on-critical-base"
            >
              {value()}
            </div>
          )}
        </Show>

        <Show
          when={!loading() && snapshot() && model()}
          fallback={
            <div class="flex flex-1 items-center justify-center p-8 text-compact text-text-weak">
              Loading retained startup history…
            </div>
          }
        >
          <div class="min-h-0 flex-1">
            <div
              role="region"
              id="diagnostics-panel-activity"
              aria-labelledby="diagnostics-tab-activity"
              hidden={tab() !== "activity"}
            >
              <div class="grid gap-4">
                <section
                  aria-label="Retained window summary"
                  data-diagnostics-range-start={model()!.bounds.startAt}
                  data-diagnostics-range-end={model()!.bounds.endAt}
                  class="workspace-data-metric-strip diagnostics-metric-strip"
                >
                  <Metric label="Current CPU" value={formatCpu(current()?.cpu)} />
                  <Metric label="Peak CPU" value={formatCpu(peakCpu())} />
                  <Metric
                    label={`Current ${memoryImpactLabel()}`}
                    value={`${formatBytes(current()?.memoryImpactBytes)}${current()?.memoryImpactComplete ? "" : " · partial"}`}
                  />
                  <Metric
                    label={`Peak ${memoryImpactLabel()}`}
                    value={`${formatBytes(peakMemoryImpact()?.memoryImpactBytes)}${peakMemoryImpact()?.memoryImpactComplete ? "" : " · partial"}`}
                  />
                </section>

                <DiagnosticsTimeline
                  points={model()!.series}
                  spikes={model()!.markers.filter(
                    (marker): marker is LocalDiagnostics.SpikeMarker => marker.type === "spike",
                  )}
                  bounds={model()!.bounds}
                />

                <Show when={model()!.churn.length > 0}>
                  <section
                    aria-labelledby="diagnostics-churn-title"
                    class="rounded-lg border border-border-weak-base p-3"
                  >
                    <h2 id="diagnostics-churn-title" class="text-compact font-medium text-text-strong">
                      Short-lived activity
                    </h2>
                    <ul class="mt-2 grid gap-1 text-xs text-text-weak">
                      <For each={model()!.churn}>
                        {(item) => (
                          <li
                            data-testid="diagnostics-churn"
                            data-owner-id={item.ownerId}
                            data-measurement={item.resourceMeasurement}
                          >
                            {snapshot()!.owners.find((owner) => owner.id === item.ownerId)?.label ?? item.ownerId}:{" "}
                            {item.launched} launched, {item.exited} exited · resources {item.resourceMeasurement}
                          </li>
                        )}
                      </For>
                    </ul>
                  </section>
                </Show>

                <p class="text-2xs text-text-weak">
                  Workspace model work shares the Claxedo server process series. Memory impact uses macOS physical
                  footprint, Windows private working set, or Linux PSS; RSS is explicitly marked as a fallback. Remote
                  runtimes are excluded. Short-lived launches remain unmeasured churn, never as zero usage, and missing
                  helpers make a sample partial.
                </p>
              </div>
            </div>

            <div
              role="region"
              id="diagnostics-panel-sessions"
              aria-labelledby="diagnostics-tab-sessions"
              hidden={tab() !== "sessions"}
            >
              <div class="grid gap-4">
                <div class="flex flex-wrap items-start justify-between gap-3">
                  <p class="max-w-2xl text-xs text-text-weak">
                    Triggered only. Scans Claxedo-owned session stores across local profiles and harnesses, then
                    measures conversation payloads currently kept warm by this renderer.
                  </p>
                  <Button variant="ghost" size="small" disabled={sessionScanBusy()} onClick={() => void scanSessions()}>
                    {sessionScanBusy()
                      ? "Scanning all sessions…"
                      : sessionScan()
                        ? "Scan again"
                        : "Scan session memory"}
                  </Button>
                </div>

                <Show when={sessionScanError()}>
                  {(value) => (
                    <p
                      role="alert"
                      class="rounded border border-border-critical-base px-3 py-2 text-xs text-text-on-critical-base"
                    >
                      {value()}
                    </p>
                  )}
                </Show>

                <Show
                  when={sessionScan()}
                  fallback={
                    <p class="rounded-lg border border-border-weak-base p-6 text-center text-xs text-text-weak">
                      No background scan runs. Start one to weigh stored sessions, split chat/image/compaction bytes,
                      and identify conversations still held warm by this renderer.
                    </p>
                  }
                >
                  {(scan) => (
                    <>
                      <section class="workspace-data-metric-strip diagnostics-metric-strip">
                        <Metric label="Stored payload" value={formatBytes(scan().stored.totalBytes)} />
                        <Metric label="Warm payload estimate" value={formatBytes(scan().resident.totalBytes)} />
                        <Metric label="Stored images" value={formatBytes(scan().stored.imageBytes)} />
                        <Metric label="Stored compactions" value={formatBytes(scan().stored.compactionBytes)} />
                      </section>

                      <section
                        aria-labelledby="diagnostics-sessions-title"
                        class="rounded-lg border border-border-weak-base"
                      >
                        <div class="border-b border-border-weak-base px-3 py-2">
                          <h2 id="diagnostics-sessions-title" class="text-compact font-medium text-text-strong">
                            Sessions by weight
                          </h2>
                          <p class="mt-0.5 text-xs text-text-weak">
                            Ranked by serialized payload. Tagged sessions are also held in memory by this renderer —
                            <span class="text-text-base"> Mounted</span> is on screen now,{" "}
                            <span class="text-text-base">Cached</span> is retained unmounted for fast switching.
                          </p>
                        </div>
                        <Show
                          when={sessions().length > 0}
                          fallback={<p class="p-4 text-sm text-text-weak">No stored or warm sessions found.</p>}
                        >
                          <div
                            aria-hidden="true"
                            class="grid grid-cols-[minmax(0,1fr)_repeat(4,minmax(72px,auto))] gap-3 border-b border-border-weak-base bg-surface-base px-3 py-1.5 text-micro uppercase tracking-wide text-text-weak max-md:hidden"
                          >
                            <span />
                            <span class="text-right">Total</span>
                            <span class="text-right">Chat</span>
                            <span class="text-right">Images</span>
                            <span class="text-right">Compaction</span>
                          </div>
                          <For each={sessions().slice(0, sessionsShown())}>
                            {(session, index) => (
                              <div
                                data-testid="diagnostics-session"
                                data-session-id={session.sessionId}
                                data-warm={session.warm ? "true" : undefined}
                                class="grid grid-cols-[minmax(0,1fr)_repeat(4,minmax(72px,auto))] items-center gap-3 border-t border-border-weak-base/40 px-3 py-2 first:border-t-0 max-md:grid-cols-[minmax(0,1fr)_auto]"
                              >
                                <span class="min-w-0">
                                  <span class="flex items-center gap-1.5 text-sm font-medium text-text-strong">
                                    <span class="truncate">
                                      {String(index() + 1)}. {session.label}
                                    </span>
                                    <Show when={session.warm}>
                                      {(warm) => (
                                        <span
                                          data-testid="diagnostics-session-tag"
                                          class="shrink-0 rounded border border-border-weak-base px-1.5 py-px text-micro font-medium uppercase tracking-wide text-text-weak"
                                        >
                                          {warm().mounted ? "Mounted" : "Cached"}
                                        </span>
                                      )}
                                    </Show>
                                  </span>
                                  <span class="block truncate text-2xs text-text-weak">
                                    {session.warm ? `${session.warm.messageCount} messages · ` : ""}
                                    {session.detail} · {session.sessionId}
                                  </span>
                                </span>
                                <Value headed label="Total" value={formatBytes(session.buckets.totalBytes)} />
                                <Value headed label="Chat" value={formatBytes(session.buckets.chatBytes)} />
                                <Value headed label="Images" value={formatBytes(session.buckets.imageBytes)} />
                                <Value headed label="Compaction" value={formatBytes(session.buckets.compactionBytes)} />
                              </div>
                            )}
                          </For>
                          <Show when={sessionsShown() < sessions().length}>
                            <div class="border-t border-border-weak-base p-2 text-center">
                              <Button
                                variant="ghost"
                                size="small"
                                onClick={() => setSessionsShown((value) => value + 25)}
                              >
                                Show 25 more ({String(sessions().length - sessionsShown())} remaining)
                              </Button>
                            </div>
                          </Show>
                        </Show>
                      </section>

                      <p class="text-2xs text-text-weak">
                        Completed in {formatDuration(scan().durationMs)}. Values estimate serialized payload, not exact
                        JavaScript heap or decoded image/GPU memory; live overhead can be higher.
                      </p>
                    </>
                  )}
                </Show>
              </div>
            </div>

            <div
              role="region"
              id="diagnostics-panel-processes"
              aria-labelledby="diagnostics-tab-processes"
              hidden={tab() !== "processes"}
            >
              <section
                aria-labelledby="diagnostics-contributors-title"
                class="rounded-lg border border-border-weak-base"
              >
                <div class="border-b border-border-weak-base px-3 py-2">
                  <h2 id="diagnostics-contributors-title" class="text-compact font-medium text-text-strong">
                    Ranked contributors
                  </h2>
                  <p class="mt-0.5 text-xs text-text-weak">
                    Ranked by peak CPU, then peak OS-native memory impact, across the retained window.
                  </p>
                </div>
                <Show
                  when={grouped().length > 0}
                  fallback={<p class="p-4 text-sm text-text-weak">No sampled local contributors in this interval.</p>}
                >
                  <For each={grouped()}>
                    {([group, contributors]) => (
                      <div class="border-b border-border-weak-base/60 last:border-b-0">
                        <h3 class="bg-surface-base px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-text-weak">
                          {group}
                        </h3>
                        <For each={contributors}>
                          {(contributor, index) => (
                            <div class="border-t border-border-weak-base/40 first:border-t-0">
                              <button
                                type="button"
                                data-testid="diagnostics-contributor"
                                data-owner-id={contributor.owner.id}
                                data-owner-kind={contributor.owner.kind}
                                data-peak-cpu={contributor.peakCpu}
                                data-rss-change={contributor.rssChangeBytes}
                                aria-expanded={!!expanded()[contributor.owner.id]}
                                aria-controls={`diagnostics-owner-${contributor.owner.id}`}
                                class="grid w-full grid-cols-[minmax(0,1fr)_repeat(4,minmax(72px,auto))] items-center gap-3 px-3 py-2 text-left hover:bg-surface-base-hover/40 focus-visible:bg-surface-base-hover max-md:grid-cols-[minmax(0,1fr)_auto]"
                                onClick={() =>
                                  setExpanded((value) => ({
                                    ...value,
                                    [contributor.owner.id]: !value[contributor.owner.id],
                                  }))
                                }
                              >
                                <span class="min-w-0">
                                  <span class="block truncate text-sm font-medium text-text-strong">
                                    {String(index() + 1)}. {contributor.owner.label}
                                  </span>
                                  <span class="block text-2xs text-text-weak">
                                    {contributor.owner.kind} · {contributor.confidence} attribution ·{" "}
                                    {contributor.processes.length} process
                                    {contributor.processes.length === 1 ? "" : "es"}
                                  </span>
                                </span>
                                <Value label="Current CPU" value={formatCpu(contributor.currentCpu)} />
                                <Value label="Peak CPU" value={formatCpu(contributor.peakCpu)} />
                                <Value
                                  label="Current memory impact"
                                  value={`${formatBytes(contributor.currentMemoryImpactBytes)}${contributor.currentMemoryImpactComplete ? "" : " · partial"}`}
                                />
                                <Value
                                  label="Memory impact change"
                                  value={formatDelta(contributor.memoryImpactChangeBytes)}
                                />
                              </button>
                              <Show when={expanded()[contributor.owner.id]}>
                                <div
                                  id={`diagnostics-owner-${contributor.owner.id}`}
                                  class="bg-surface-base/60 px-3 py-3"
                                >
                                  <div class="flex flex-wrap items-center justify-between gap-2">
                                    <p class="text-xs text-text-weak">
                                      {contributor.owner.lifecycle} · {contributor.owner.access}
                                      {contributor.owner.workspaceId
                                        ? ` · workspace ${contributor.owner.workspaceId}`
                                        : ""}
                                    </p>
                                    <ActionControls
                                      ownerId={contributor.owner.id}
                                      eligibility={contributor.actionEligibility}
                                      busy={busy()}
                                      onAction={act}
                                    />
                                  </div>
                                  <ul class="mt-2 grid gap-1" aria-label={`${contributor.owner.label} process tree`}>
                                    <For each={contributor.processes}>
                                      {(process) => (
                                        <li class="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-3 rounded border border-border-weak-base px-2 py-1.5 text-xs">
                                          <span class="truncate text-text-base">
                                            {process.parentProcessId ? "↳ " : ""}
                                            {process.label}
                                          </span>
                                          <span class="text-text-weak">PID {process.identity.pid}</span>
                                          <span class="text-text-weak">{process.lifecycle}</span>
                                        </li>
                                      )}
                                    </For>
                                  </ul>
                                </div>
                              </Show>
                            </div>
                          )}
                        </For>
                      </div>
                    )}
                  </For>
                </Show>
              </section>
            </div>
          </div>
        </Show>
        <p class="sr-only" aria-live="polite">
          {announcement()}
        </p>
      </div>
    </Dialog>
  )
}

function Metric(props: { label: string; value: string }) {
  return (
    <div>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  )
}

function Value(props: { label: string; value: string; headed?: boolean }) {
  return (
    <span class="text-right max-md:hidden">
      {/* Under a column header the per-row label is redundant ink, but it still has
          to name the number for anyone reading the row on its own. */}
      <span class={props.headed ? "sr-only" : "block text-micro uppercase text-text-weak"}>{props.label}</span>
      <span class="block text-xs tabular-nums text-text-base">{props.value}</span>
    </span>
  )
}

function ActionControls(props: {
  ownerId: string
  eligibility: LocalDiagnostics.ActionEligibility
  busy?: string
  onAction(ownerId: string, action: LocalDiagnostics.ActionKind, grant: LocalDiagnostics.ActionGrant): Promise<void>
}) {
  return (
    <Show
      when={props.eligibility.state === "eligible" ? props.eligibility : undefined}
      fallback={
        <span class="text-xs text-text-weak">
          Read only · {props.eligibility.state === "ineligible" ? props.eligibility.reason : "unregistered-owner"}
        </span>
      }
    >
      {(eligibility) => (
        <div class="flex items-center gap-1">
          <For each={eligibility().actions}>
            {(grant) => (
              <Button
                variant="ghost"
                size="small"
                disabled={props.busy === `${props.ownerId}:${grant.action}`}
                onClick={() => void props.onAction(props.ownerId, grant.action, grant)}
              >
                {grant.action === "stop" ? "Stop gracefully" : "Kill owned tree"}
              </Button>
            )}
          </For>
        </div>
      )}
    </Show>
  )
}

function sourceTransition(
  previous: LocalDiagnostics.SourceStatus[] | undefined,
  next: LocalDiagnostics.SourceStatus[],
) {
  if (!previous) return
  const prior = new Map(previous.map((source) => [`${source.domain}:${source.source}`, source.state]))
  const changes = next.flatMap((source) => {
    const state = prior.get(`${source.domain}:${source.source}`)
    if (!state || state === source.state) return []
    return [`${source.source} on ${source.domain} changed from ${state} to ${source.state}`]
  })
  if (changes.length === 0) return
  return `Collector source update: ${changes.join("; ")}.`
}

function formatCpu(value: number | undefined) {
  return value === undefined ? "Unavailable" : `${value.toFixed(value >= 10 ? 0 : 1)}%`
}

function formatBytes(value: number | undefined) {
  if (value === undefined) return "Unavailable"
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KiB`
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MiB`
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GiB`
}

function formatDelta(value: number | undefined) {
  if (value === undefined) return "Unavailable"
  return `${value >= 0 ? "+" : "−"}${formatBytes(Math.abs(value))}`
}

function formatDuration(value: number) {
  if (value < 1_000) return `${value} ms`
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} s`
}

function message(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause)
}
