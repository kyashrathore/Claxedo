import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"

import type { LocalDiagnostics } from "../data/local-diagnostics"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { buildDiagnosticsModel, ownerGroup } from "./diagnostics/model"
import { DiagnosticsTimeline, formatTime } from "./diagnostics/timeline"

export function DialogProcessDiagnostics(props: {
  warmSessions?: () => LocalDiagnostics.WarmSessionMemory[]
}) {
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
  const [storedSessionsShown, setStoredSessionsShown] = createSignal(100)
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
      setError("Local performance diagnostics are available only in the Claxedo desktop app.")
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
  const grouped = createMemo(() =>
    [...Map.groupBy(model()?.contributors ?? [], (contributor) => ownerGroup(contributor.owner.kind)).entries()])
  const current = createMemo(() => model()?.series.at(-1))
  const peakCpu = createMemo(() =>
    Math.max(0, ...(model()?.series.flatMap((point) => point.cpu === undefined ? [] : [point.cpu]) ?? [])))
  const peakRss = createMemo(() =>
    Math.max(0, ...(model()?.series.flatMap((point) => point.rssBytes === undefined ? [] : [point.rssBytes]) ?? [])))
  const warmSessions = createMemo(() => sessionScan()?.warmSessions.toSorted(
    (left, right) => right.buckets.totalBytes - left.buckets.totalBytes || left.recency - right.recency,
  ) ?? [])
  const storedSessions = createMemo(() => sessionScan()?.sessions.slice(0, storedSessionsShown()) ?? [])

  const scanSessions = async () => {
    if (!capability || sessionScanBusy()) return
    setSessionScanBusy(true)
    setSessionScanError(undefined)
    try {
      const result = await capability.scanSessionMemory({ warmSessions: props.warmSessions?.() ?? [] })
      setSessionScan(result)
      setStoredSessionsShown(100)
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

  const act = async (
    ownerId: string,
    action: LocalDiagnostics.ActionKind,
    grant: LocalDiagnostics.ActionGrant,
  ) => {
    if (!capability) return
    const key = `${ownerId}:${action}`
    setBusy(key)
    try {
      const result = action === "stop"
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
    <Dialog title="Local performance diagnostics" size="x-large" transition class="claxedo-diagnostics-dialog">
      <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div class="flex flex-wrap items-start justify-between gap-3 border-b border-border-weak-base px-5 py-3 max-md:px-3">
          <div>
            <div class="flex items-center gap-2 text-[13px] font-medium text-text-strong">
              <span
                class={`inline-block h-2 w-2 rounded-full ${
                  error() || disconnected() ? "bg-icon-warning-base" : "bg-icon-success-base"
                }`}
              />
              {error() ? "Collector unavailable" : disconnected() ? "Collector disconnected" : "Collector active"}
            </div>
            <Show when={snapshot()}>
              {(value) => (
                <p class="mt-1 text-[11px] text-text-weak">
                  History starts {formatTime(value().retainedFromAt)} · last sample {formatTime(value().capturedAt)}
                  {value().retention.state === "truncated" ? " · retained history is memory-limited" : ""}
                </p>
              )}
            </Show>
          </div>
          <Button variant="ghost" size="small" disabled={loading()} onClick={() => void load()}>Retry / refresh</Button>
        </div>

        <Show when={error()}>
          {(value) => (
            <div role="alert" class="mx-5 mt-3 rounded-md border border-border-critical-base bg-surface-critical-base/10 px-3 py-2 text-[12px] text-text-on-critical-base max-md:mx-3">
              {value()}
            </div>
          )}
        </Show>

        <Show
          when={!loading() && snapshot() && model()}
          fallback={<div class="flex flex-1 items-center justify-center p-8 text-[13px] text-text-weak">Loading retained startup history…</div>}
        >
          <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overflow-x-hidden px-5 py-4 max-md:px-3">
              <section
                aria-label="Retained window summary"
                data-diagnostics-range-start={model()!.bounds.startAt}
                data-diagnostics-range-end={model()!.bounds.endAt}
                class="grid grid-cols-4 overflow-hidden rounded-lg border border-border-weak-base max-md:grid-cols-2"
              >
                <Metric label="Current CPU" value={formatCpu(current()?.cpu)} />
                <Metric label="Peak CPU" value={formatCpu(peakCpu())} />
                <Metric label="Current RSS" value={formatBytes(current()?.rssBytes)} />
                <Metric label="Peak RSS" value={formatBytes(peakRss())} />
              </section>

              <section aria-labelledby="diagnostics-session-memory-title" class="rounded-lg border border-border-weak-base">
                <div class="flex flex-wrap items-start justify-between gap-3 border-b border-border-weak-base px-3 py-2.5">
                  <div>
                    <h2 id="diagnostics-session-memory-title" class="text-[13px] font-medium text-text-strong">Session memory</h2>
                    <p class="mt-0.5 max-w-3xl text-[11px] text-text-weak">
                      Triggered only. Scans local Claxedo, Codex, and Claude session stores, then measures conversation payloads currently kept warm by this renderer.
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="small"
                    disabled={sessionScanBusy()}
                    onClick={() => void scanSessions()}
                  >
                    {sessionScanBusy() ? "Scanning all sessions…" : sessionScan() ? "Scan again" : "Scan session memory"}
                  </Button>
                </div>

                <Show when={sessionScanError()}>
                  {(value) => <p role="alert" class="m-3 rounded border border-border-critical-base px-3 py-2 text-[11px] text-text-on-critical-base">{value()}</p>}
                </Show>

                <Show
                  when={sessionScan()}
                  fallback={
                    <div class="p-3 text-[11px] text-text-weak">
                      No background scan runs. Start one to rank large sessions, split chat/image/compaction bytes, and identify mounted or retained warm conversations.
                    </div>
                  }
                >
                  {(scan) => (
                    <div class="grid gap-3 p-3">
                      <div class="grid grid-cols-4 overflow-hidden rounded border border-border-weak-base max-md:grid-cols-2">
                        <Metric label="Stored payload" value={formatBytes(scan().stored.totalBytes)} />
                        <Metric label="Warm payload estimate" value={formatBytes(scan().resident.totalBytes)} />
                        <Metric label="Stored images" value={formatBytes(scan().stored.imageBytes)} />
                        <Metric label="Stored compactions" value={formatBytes(scan().stored.compactionBytes)} />
                      </div>

                      <div>
                        <h3 class="text-[11px] font-medium uppercase tracking-wide text-text-weak">Scanned stores</h3>
                        <div class="mt-1.5 flex flex-wrap gap-1.5">
                          <For each={scan().sources}>
                            {(source) => (
                              <span
                                data-testid="diagnostics-session-memory-source"
                                data-state={source.state}
                                class="rounded-full border border-border-weak-base px-2 py-1 text-[10px] text-text-weak"
                              >
                                {source.harness}{source.profile ? ` · ${source.profile}` : ""} · {source.state} · {source.sessionCount} sessions · {formatBytes(source.buckets.totalBytes)}
                              </span>
                            )}
                          </For>
                        </div>
                      </div>

                      <div class="rounded border border-border-weak-base">
                        <div class="border-b border-border-weak-base px-2.5 py-2">
                          <h3 class="text-[12px] font-medium text-text-strong">Warm sessions</h3>
                          <p class="mt-0.5 text-[10px] text-text-weak">
                            Mounted sessions are visible now. Retained sessions are unmounted conversation clients kept for fast switching and can still add memory overhead.
                          </p>
                        </div>
                        <Show when={warmSessions().length > 0} fallback={<p class="p-3 text-[11px] text-text-weak">No conversations are currently warm in this renderer.</p>}>
                          <ul class="divide-y divide-border-weak-base/60">
                            <For each={warmSessions()}>
                              {(session) => (
                                <li data-testid="diagnostics-warm-session" class="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-2.5 py-2 text-[11px]">
                                  <span class="min-w-0">
                                    <span class="block truncate font-medium text-text-base">{session.sessionId}</span>
                                    <span class="text-[10px] text-text-weak">
                                      {session.mounted ? "Mounted" : "Retained unmounted"} · {session.messageCount} messages · warm rank {session.recency + 1}
                                    </span>
                                  </span>
                                  <MemoryBuckets buckets={session.buckets} />
                                </li>
                              )}
                            </For>
                          </ul>
                        </Show>
                      </div>

                      <div class="rounded border border-border-weak-base">
                        <div class="border-b border-border-weak-base px-2.5 py-2">
                          <h3 class="text-[12px] font-medium text-text-strong">Largest stored sessions</h3>
                          <p class="mt-0.5 text-[10px] text-text-weak">All stores are analyzed; rows are ranked by serialized size and rendered in batches.</p>
                        </div>
                        <Show when={scan().sessions.length > 0} fallback={<p class="p-3 text-[11px] text-text-weak">No stored sessions found.</p>}>
                          <ul class="divide-y divide-border-weak-base/60">
                            <For each={storedSessions()}>
                              {(session) => (
                                <li data-testid="diagnostics-stored-session" class="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-2.5 py-2 text-[11px]">
                                  <span class="min-w-0">
                                    <span class="block truncate font-medium text-text-base">{session.title ?? session.sessionId}</span>
                                    <span class="block truncate text-[10px] text-text-weak">
                                      {session.harness}{session.profile ? ` · ${session.profile}` : ""} · {session.sessionId}
                                    </span>
                                  </span>
                                  <MemoryBuckets buckets={session.buckets} />
                                </li>
                              )}
                            </For>
                          </ul>
                          <Show when={storedSessionsShown() < scan().sessions.length}>
                            <div class="border-t border-border-weak-base p-2 text-center">
                              <Button variant="ghost" size="small" onClick={() => setStoredSessionsShown((value) => value + 100)}>
                                Show 100 more
                              </Button>
                            </div>
                          </Show>
                        </Show>
                      </div>

                      <p class="text-[10px] text-text-weak">
                        Completed in {formatDuration(scan().durationMs)}. Values estimate serialized payload, not exact JavaScript heap or decoded image/GPU memory; live overhead can be higher.
                      </p>
                    </div>
                  )}
                </Show>
              </section>

              <DiagnosticsTimeline
                points={model()!.series}
                spikes={model()!.markers.filter((marker): marker is LocalDiagnostics.SpikeMarker => marker.type === "spike")}
                bounds={model()!.bounds}
              />

              <Show when={model()!.markers.some((marker) => marker.type === "spike")}>
                <section aria-labelledby="diagnostics-spikes-title" class="rounded-lg border border-border-weak-base p-3">
                  <h2 id="diagnostics-spikes-title" class="text-[13px] font-medium text-text-strong">Attributed spikes</h2>
                  <p class="mt-0.5 text-[11px] text-text-weak">Automatic resource jumps correlated with the active route, workbench surfaces, terminal residency, and focused session render size.</p>
                  <ul class="mt-2 grid gap-1.5 text-[11px] text-text-weak">
                    <For each={model()!.markers.filter((marker): marker is LocalDiagnostics.SpikeMarker => marker.type === "spike").toReversed()}>
                      {(spike) => (
                        <li data-testid="diagnostics-attributed-spike" class="rounded border border-border-weak-base px-2 py-1.5">
                          <span class="font-medium text-text-base">{formatTime(spike.at)} · {describeSpike(spike, snapshot()!)}</span>
                          <Show when={spike.context}>
                            {(context) => <span class="ml-1">· {describeContext(context())}</span>}
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
                </section>
              </Show>

              <section aria-labelledby="diagnostics-sources-title" class="rounded-lg border border-border-weak-base p-3">
                <h2 id="diagnostics-sources-title" class="text-[13px] font-medium text-text-strong">Collector sources</h2>
                <div class="mt-2 flex flex-wrap gap-2">
                  <For each={snapshot()!.sources}>
                    {(source) => (
                      <span
                        data-testid="diagnostics-source"
                        data-source={source.source}
                        data-state={source.state}
                        class="rounded-full border border-border-weak-base px-2 py-1 text-[11px] text-text-weak"
                      >
                        {source.source} · {source.state} · {source.accuracy}
                        {source.state !== "unsupported" && "lastSuccessAt" in source && source.lastSuccessAt
                          ? ` · ${formatTime(source.lastSuccessAt)}`
                          : ""}
                      </span>
                    )}
                  </For>
                </div>
                <p class="mt-2 text-[11px] text-text-weak">
                  Workspace model work shares the Claxedo server process series. Remote runtimes are excluded. Short-lived
                  launches without a native sample remain visible as unmeasured churn, never as zero usage.
                </p>
              </section>

              <section aria-labelledby="diagnostics-contributors-title" class="rounded-lg border border-border-weak-base">
                <div class="border-b border-border-weak-base px-3 py-2">
                  <h2 id="diagnostics-contributors-title" class="text-[13px] font-medium text-text-strong">Ranked contributors</h2>
                  <p class="mt-0.5 text-[11px] text-text-weak">Ranked by peak CPU, then peak resident memory, across the retained window.</p>
                </div>
                <Show when={grouped().length > 0} fallback={<p class="p-4 text-[12px] text-text-weak">No sampled local contributors in this interval.</p>}>
                  <For each={grouped()}>
                    {([group, contributors]) => (
                      <div class="border-b border-border-weak-base/60 last:border-b-0">
                        <h3 class="bg-surface-base px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-text-weak">{group}</h3>
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
                                onClick={() => setExpanded((value) => ({
                                  ...value,
                                  [contributor.owner.id]: !value[contributor.owner.id],
                                }))}
                              >
                                <span class="min-w-0">
                                  <span class="block truncate text-[12px] font-medium text-text-strong">
                                    {String(index() + 1)}. {contributor.owner.label}
                                  </span>
                                  <span class="block text-[10px] text-text-weak">
                                    {contributor.owner.kind} · {contributor.confidence} attribution · {contributor.processes.length} process{contributor.processes.length === 1 ? "" : "es"}
                                  </span>
                                </span>
                                <Value label="Current CPU" value={formatCpu(contributor.currentCpu)} />
                                <Value label="Peak CPU" value={formatCpu(contributor.peakCpu)} />
                                <Value label="Current RSS" value={formatBytes(contributor.currentRssBytes)} />
                                <Value label="RSS change" value={formatDelta(contributor.rssChangeBytes)} />
                              </button>
                              <Show when={expanded()[contributor.owner.id]}>
                                <div id={`diagnostics-owner-${contributor.owner.id}`} class="bg-surface-base/60 px-3 py-3">
                                  <div class="flex flex-wrap items-center justify-between gap-2">
                                    <p class="text-[11px] text-text-weak">
                                      {contributor.owner.lifecycle} · {contributor.owner.access}
                                      {contributor.owner.workspaceId ? ` · workspace ${contributor.owner.workspaceId}` : ""}
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
                                        <li class="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-3 rounded border border-border-weak-base px-2 py-1.5 text-[11px]">
                                          <span class="truncate text-text-base">
                                            {process.parentProcessId ? "↳ " : ""}{process.label}
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

              <Show when={model()!.churn.length > 0}>
                <section aria-labelledby="diagnostics-churn-title" class="rounded-lg border border-border-weak-base p-3">
                  <h2 id="diagnostics-churn-title" class="text-[13px] font-medium text-text-strong">Short-lived activity</h2>
                  <ul class="mt-2 grid gap-1 text-[11px] text-text-weak">
                    <For each={model()!.churn}>
                      {(item) => (
                        <li
                          data-testid="diagnostics-churn"
                          data-owner-id={item.ownerId}
                          data-measurement={item.resourceMeasurement}
                        >
                          {snapshot()!.owners.find((owner) => owner.id === item.ownerId)?.label ?? item.ownerId}: {item.launched} launched, {item.exited} exited · resources {item.resourceMeasurement}
                        </li>
                      )}
                    </For>
                  </ul>
                </section>
              </Show>

          </div>
        </Show>
        <p class="sr-only" aria-live="polite">{announcement()}</p>
      </div>
    </Dialog>
  )
}

function Metric(props: { label: string; value: string }) {
  return (
    <div class="border-r border-border-weak-base p-3 last:border-r-0 max-md:border-b">
      <div class="text-[10px] uppercase tracking-wide text-text-weak">{props.label}</div>
      <div class="mt-1 text-[18px] font-medium tabular-nums text-text-strong">{props.value}</div>
    </div>
  )
}

function Value(props: { label: string; value: string }) {
  return (
    <span class="text-right max-md:hidden">
      <span class="block text-[9px] uppercase text-text-weak">{props.label}</span>
      <span class="block text-[11px] tabular-nums text-text-base">{props.value}</span>
    </span>
  )
}

function MemoryBuckets(props: { buckets: LocalDiagnostics.SessionMemoryBuckets }) {
  return (
    <span class="grid min-w-[270px] grid-cols-4 gap-2 text-right tabular-nums max-md:min-w-[220px]">
      <Bucket label="Total" value={props.buckets.totalBytes} strong />
      <Bucket label="Chat" value={props.buckets.chatBytes} />
      <Bucket label="Images" value={props.buckets.imageBytes} />
      <Bucket label="Compaction" value={props.buckets.compactionBytes} />
    </span>
  )
}

function Bucket(props: { label: string; value: number; strong?: boolean }) {
  return (
    <span>
      <span class="block text-[9px] uppercase text-text-weak">{props.label}</span>
      <span class={`block text-[10px] ${props.strong ? "font-medium text-text-strong" : "text-text-base"}`}>{formatBytes(props.value)}</span>
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
        <span class="text-[11px] text-text-weak">
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

function describeSpike(spike: LocalDiagnostics.SpikeMarker, snapshot: LocalDiagnostics.RetainedSnapshot) {
  const owner = spike.ownerId
    ? snapshot.owners.find((candidate) => candidate.id === spike.ownerId)?.label ?? spike.ownerId
    : snapshot.processes.find((process) => process.identity.id === spike.processId)?.label ?? spike.processId
  return spike.metric === "cpu"
    ? `${owner} CPU ${formatCpu(spike.value)} (${formatCpu(spike.delta)} jump)`
    : `${owner} RSS ${formatBytes(spike.value)} (+${formatBytes(spike.delta)})`
}

function describeContext(context: LocalDiagnostics.Context) {
  const workbench = context.workbench
  const panel = context.workspacePanel
  const session = context.sessionRender
  return [
    context.screen,
    workbench.focusedSurface ? `surface ${workbench.focusedSurface}` : undefined,
    workbench.focusedPaneId ? `pane ${workbench.focusedPaneId}` : undefined,
    `${workbench.paneCount} layout pane${workbench.paneCount === 1 ? "" : "s"}`,
    workbench.stashedSurfaceCount ? `${workbench.stashedSurfaceCount} stashed surface${workbench.stashedSurfaceCount === 1 ? "" : "s"}` : undefined,
    `${context.terminalTabs.total} mounted terminal tab${context.terminalTabs.total === 1 ? "" : "s"} (${context.terminalTabs.paneBound} pane-bound, ${context.terminalTabs.stashed} stashed)`,
    panel.open ? `workspace panel ${[panel.mode, panel.tab, panel.navigator].filter(Boolean).join("/")}` : "workspace panel closed",
    session ? `rendered session ${session.sessionId}: DOM ${session.domNodeCount} · ${session.mountedTimelineRowCount}/${session.timelineRowCount} timeline rows mounted · ${session.messageCount} messages` : undefined,
    context.sessionId ? `session ${context.sessionId}` : undefined,
    context.workspaceId ? `workspace ${context.workspaceId}` : undefined,
  ].filter((item): item is string => !!item).join(" · ")
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
