import { For, Show, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { Tabs } from "@opencode-ai/ui/tabs"
import { showToast } from "@opencode-ai/ui/toast"
import { usePlatform } from "@/context/platform"
import { useClaxedoState } from "../state"
import { getClaxedoServerUrl } from "../../utils/api"
import { Process } from "@/process/process"
import { errorText } from "../utils/text"
import { formatMB, formatCPU } from "../utils/process-stats-format"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { Icon } from "@opencode-ai/ui/icon"
import { createProcessClient } from "../../process/client"
import { resolveWorkspaceRuntime } from "../../cloud/workspace-runtime-store"
import {
  EMPTY_BUCKET,
  buildExternal,
  clipped,
  formatAge,
  formatUptimeSeconds,
  kindLabel,
  kindTone,
  reasonLabel,
  rooted,
  score,
} from "./process-diagnostics/groups"

type Snapshot = Process.DiagnosticSnapshot
type OsRow = Process.DiagnosticOsProcess
type Group = Process.DiagnosticGroup
type OsFilter = "all" | "managed" | Process.DiagnosticStatus

type ResourceRow = {
  key: string
  kind: "managed" | "terminal"
  title: string
  directory: string
  terminalId?: string
  processId?: string
  surfaceId?: string
  paneId?: string
  cpu: number
  rssKb: number
  os: OsRow[]
  status: string
}

/* ─── Visual primitives ─── */

function StatusDot(props: { status: string; size?: "sm" | "md" }) {
  const px = () => (props.size === "md" ? "8px" : "6px")
  const bg = () => {
    const s = props.status
    if (s === "stale" || s === "crashed") return "bg-icon-critical-base"
    if (s === "suspect" || s === "restarting" || s === "starting") return "bg-icon-warning-base"
    if (s === "running" || s === "active" || s === "ok") return "bg-icon-success-base"
    return "bg-border-weak-base"
  }
  const pulse = () => props.status === "stale" || props.status === "crashed"

  return (
    <span class="relative inline-flex shrink-0" style={{ width: px(), height: px() }}>
      <Show when={pulse()}>
        <span class={`absolute inset-0 rounded-full opacity-40 animate-ping ${bg()}`} />
      </Show>
      <span class={`relative inline-flex rounded-full ${bg()}`} style={{ width: px(), height: px() }} />
    </span>
  )
}

function StatusPill(props: { value: string }) {
  const tone = () => {
    if (props.value === "stale" || props.value === "crashed") return "bg-surface-critical-base/15 text-text-on-critical-base"
    if (props.value === "suspect" || props.value === "restarting" || props.value === "starting") {
      return "bg-surface-warning-base/15 text-text-on-warning-base"
    }
    if (props.value === "running" || props.value === "active") return "bg-surface-success-base/15 text-text-on-success-base"
    return "bg-surface-base-hover text-text-weak"
  }

  return (
    <span class={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium leading-none ${tone()}`}>
      {props.value}
    </span>
  )
}

/* ─── Main component ─── */

export function DialogProcessDiagnostics(props: { directory?: string }) {
  const platform = usePlatform()
  const claxedoServerUrl = getClaxedoServerUrl()
  const state = useClaxedoState()
  const fetchFn = platform.fetch ?? globalThis.fetch
  const processClient = () => createProcessClient({
    baseUrl: claxedoServerUrl,
    directory: activeDirectory(),
    fetch: fetchFn,
    resolveWorkspaceRuntime: (input) => resolveWorkspaceRuntime({
      baseUrl: claxedoServerUrl,
      request: fetchFn,
      directory: input.directory,
    }),
  })

  const [data, setData] = createSignal<Snapshot>()
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string>()
  const [busy, setBusy] = createSignal<Partial<Record<string, boolean>>>({})
  const [view, setView] = createSignal("overview")
  const [open, setOpen] = createSignal<Partial<Record<string, boolean>>>({})
  const [osFilter, setOsFilter] = createSignal<OsFilter>("all")

  const activeDirectory = () => props.directory || ""
  let abortCtrl: AbortController | undefined

  const load = async () => {
    if (!claxedoServerUrl) return
    abortCtrl?.abort()
    abortCtrl = new AbortController()
    const { signal } = abortCtrl
    setLoading(true)
    setError(undefined)
    try {
      setData(await processClient().diagnostics({ signal }))
    } catch (err) {
      if (signal.aborted) return
      setError(errorText(err))
    } finally {
      if (!signal.aborted) setLoading(false)
    }
  }

  onMount(() => {
    void load()
  })

  onCleanup(() => {
    abortCtrl?.abort()
  })

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy((prev) => ({ ...prev, [key]: true }))
    try {
      await fn()
      await load()
    } catch (err) {
      showToast({
        title: "Diagnostics action failed",
        description: errorText(err),
        variant: "error",
      })
    } finally {
      setBusy((prev) => ({ ...prev, [key]: false }))
    }
  }

  const tabs = createMemo(() => {
    const byTerminal = new Map<string, { surfaceId: string; title: string; paneId: string; directory: string }>()
    const bySession = new Map<string, { surfaceId: string; title: string; paneId: string; directory: string }>()
    for (const tab of state.meta.all()) {
      const paneId = state.wb.selectors.contentPane(tab.id) ?? ""
      if (tab.type === "terminal" && tab.terminalId && tab.directory) {
        byTerminal.set(tab.terminalId, {
          surfaceId: tab.id,
          title: tab.content?.title ?? tab.type,
          paneId,
          directory: tab.directory,
        })
      }
      if (tab.sessionId && tab.directory) {
        bySession.set(tab.sessionId, {
          surfaceId: tab.id,
          title: tab.content?.title ?? tab.type,
          paneId,
          directory: tab.directory,
        })
      }
    }
    return { byTerminal, bySession }
  })

  const indexes = createMemo(() => {
    const snapshot = data()
    return {
      configById: new Map((snapshot?.configs ?? []).map((item) => [item.id, item] as const)),
      processById: new Map((snapshot?.processes ?? []).map((item) => [item.configId, item] as const)),
      ptyById: new Map((snapshot?.ptys ?? []).map((item) => [item.id, item] as const)),
    }
  })

  const trackedResources = createMemo<ResourceRow[]>(() => {
    const snapshot = data()
    if (!snapshot) return []

    const rows: ResourceRow[] = []
    const usedPtys = new Set<string>()

    for (const config of snapshot.configs) {
      const proc = indexes().processById.get(config.id)
      const pty = proc?.ptyId ? indexes().ptyById.get(proc.ptyId) : undefined
      if (pty?.id) usedPtys.add(pty.id)
      const related = snapshot.os.filter((row) => row.process_id === config.id || (!!proc?.ptyId && row.terminal_id === proc.ptyId))
      const tab = proc?.ptyId ? tabs().byTerminal.get(proc.ptyId) : undefined
      rows.push({
        key: `managed:${config.id}`,
        kind: "managed",
        title: config.name,
        directory: config.cwd || snapshot.directory,
        terminalId: proc?.ptyId,
        processId: config.id,
        surfaceId: tab?.surfaceId,
        paneId: tab?.paneId,
        cpu: related.reduce((sum, row) => sum + row.cpu_percent, 0),
        rssKb: related.reduce((sum, row) => sum + row.rss_kb, 0),
        os: related,
        status: proc?.status ?? "idle",
      })
    }

    for (const pty of snapshot.ptys) {
      if (usedPtys.has(pty.id)) continue
      const related = snapshot.os.filter((row) => row.terminal_id === pty.id || row.pid === pty.pid)
      const tab = tabs().byTerminal.get(pty.id)
      rows.push({
        key: `terminal:${pty.id}`,
        kind: "terminal",
        title: tab?.title || pty.title,
        directory: pty.cwd,
        terminalId: pty.id,
        surfaceId: tab?.surfaceId,
        paneId: tab?.paneId,
        cpu: related.reduce((sum, row) => sum + row.cpu_percent, 0),
        rssKb: related.reduce((sum, row) => sum + row.rss_kb, 0),
        os: related,
        status: pty.status,
      })
    }

    return rows.sort((a, b) => score(b.status) - score(a.status) || b.rssKb - a.rssKb || b.cpu - a.cpu)
  })

  const resourceLookup = createMemo(() => {
    const byProcess = new Map<string, ResourceRow>()
    const byTerminal = new Map<string, ResourceRow>()
    for (const row of trackedResources()) {
      if (row.processId) byProcess.set(row.processId, row)
      if (row.terminalId) byTerminal.set(row.terminalId, row)
    }
    return { byProcess, byTerminal }
  })

  const osRows = createMemo(() =>
    [...(data()?.os ?? [])].sort((a, b) => score(b.status) - score(a.status) || b.rss_kb - a.rss_kb || b.cpu_percent - a.cpu_percent),
  )
  const owners = createMemo(() => data()?.owners ?? [])
  const leaks = createMemo(() => data()?.leaks ?? [])
  const other = createMemo(() => buildExternal(data()?.os ?? []))
  const summary = createMemo(() => data()?.summary ?? { current: EMPTY_BUCKET, leaked: EMPTY_BUCKET, external: EMPTY_BUCKET })
  const staleRows = createMemo(() => osRows().filter((row) => row.status === "stale"))

  const health = createMemo(() => {
    const s = summary()
    const parts: string[] = []
    if (s.leaked.groups > 0) parts.push(`${s.leaked.groups} stale`)
    if (s.current.problem_children > 0) parts.push(`${s.current.problem_children} unhealthy`)
    return { ok: parts.length === 0, label: parts.length > 0 ? parts.join(", ") : "All healthy" }
  })

  const totalRss = createMemo(() => {
    const s = summary()
    return s.current.rss_kb + s.leaked.rss_kb + s.external.rss_kb + (data()?.server?.rss_kb ?? 0)
  })

  const focusTab = (paneId: string | undefined, surfaceId: string | undefined) => {
    if (!paneId || !surfaceId) return false
    state.wb.split.focus(paneId)
    state.layout.showContent(surfaceId)
    return true
  }

  const openTerminal = (row: ResourceRow) => {
    if (focusTab(row.paneId, row.surfaceId)) return
    if (!row.terminalId) return
    state.layout.openTerminal(row.directory || activeDirectory(), row.terminalId, row.title)
  }

  const openPty = (id: string, title?: string) => {
    const item = resourceLookup().byTerminal.get(id)
    if (item) {
      openTerminal(item)
      return
    }
    const pty = indexes().ptyById.get(id)
    if (!pty) return
    const tab = tabs().byTerminal.get(id)
    if (focusTab(tab?.paneId, tab?.surfaceId)) return
    state.layout.openTerminal(pty.cwd || activeDirectory(), id, title || tab?.title || pty.title)
  }

  const linkedResource = (row: OsRow) =>
    (row.tracked_process_id ? resourceLookup().byProcess.get(row.tracked_process_id) : undefined) ||
    (row.process_id ? resourceLookup().byProcess.get(row.process_id) : undefined) ||
    (row.tracked_pty_id ? resourceLookup().byTerminal.get(row.tracked_pty_id) : undefined) ||
    (row.terminal_id ? resourceLookup().byTerminal.get(row.terminal_id) : undefined)

  const openLinkedTerminal = (row: OsRow) => {
    const item = linkedResource(row)
    if (!item?.terminalId) return
    openTerminal(item)
  }

  const openGroup = (group: Group) => {
    if (!group.terminal_id) return
    openPty(group.terminal_id, group.title)
  }

  const managedId = (row: OsRow): string | undefined => {
    const item = linkedResource(row)
    if (item?.processId) return item.processId
    if (row.process_id && indexes().configById.has(row.process_id)) return row.process_id
    return undefined
  }

  const workspace = (group: Group): string | undefined => {
    if (group.kind !== "managed_process" || !group.process_id) return undefined
    return rooted(data()?.directory || activeDirectory(), indexes().configById.get(group.process_id)?.cwd)
  }

  const managedRow = (row: OsRow) => !!managedId(row)

  const filteredOsRows = createMemo(() => {
    const value = osFilter()
    if (value === "all") return osRows()
    if (value === "managed") return osRows().filter(managedRow)
    return osRows().filter((row) => row.status === value)
  })

  const terminate = async (input: {
    pid?: number
    pty_id?: string
    process_id?: string
    group_key?: string
    signal?: "SIGTERM" | "SIGKILL"
    scope?: "pid" | "group"
  }) => {
    await processClient().terminateDiagnostic(input)
  }

  const claimedPorts = createMemo(() => {
    const ports = new Set<number>()
    const listening = new Set(data()?.listening_ports ?? [])
    for (const row of osRows()) {
      if (row.port != null && listening.has(row.port)) ports.add(row.port)
    }
    return ports
  })

  const toggle = (key: string) => {
    setOpen((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  const filterOptions: Array<{ value: OsFilter; label: string; hint?: string }> = [
    { value: "all", label: "All" },
    { value: "managed", label: "Managed", hint: "Processes defined in your project config and started by the app" },
    { value: "stale", label: "Stale", hint: "Still running but no longer tracked — orphaned terminal or dead port" },
    { value: "suspect", label: "Suspect", hint: "Process is in an unhealthy OS state or has been running for 7+ days" },
    { value: "active", label: "Active", hint: "Tracked and running normally" },
  ]

  const filterCount = (value: OsFilter) => {
    if (value === "all") return osRows().length
    if (value === "managed") return osRows().filter(managedRow).length
    return osRows().filter((row) => row.status === value).length
  }

  /* ─── Render ─── */

  return (
    <Dialog title="Process Diagnostics" size="x-large" class="claxedo-diagnostics-dialog">
      <div class="flex h-full min-h-0 flex-col">
        {/* ── Status bar ── */}
        <div class="flex flex-wrap items-center gap-2 px-5 pb-3 max-md:px-3 max-md:pb-2">
          <StatusDot status={health().ok ? "ok" : "stale"} size="md" />
          <span class="text-[13px] font-medium text-text-strong">{health().label}</span>
          <span class="min-w-0 flex-1 text-[12px] text-text-weak max-md:basis-full max-md:pl-5">
            {summary().current.groups} workloads · {osRows().length} processes · {formatMB(totalRss())}
          </span>
          <div class="flex-1 max-md:hidden" />
          <Button variant="ghost" size="small" disabled={loading()} onClick={() => void load()}>
            Refresh
          </Button>
        </div>

        <Show when={error()}>
          {(err) => (
            <div class="mx-5 mb-3 rounded-md border border-border-critical-base/20 bg-surface-critical-base/8 px-3 py-2 text-[12px] text-text-on-critical-base">
              {err()}
            </div>
          )}
        </Show>

        <Show when={!loading()} fallback={<div class="flex flex-1 items-center justify-center text-[13px] text-text-weak">Loading...</div>}>
          <Tabs value={view()} onChange={(value: string) => setView(value)} variant="alt" class="flex min-h-0 flex-1 flex-col">
            <div class="border-b border-border-weak-base px-5 max-md:px-3">
              <Tabs.List class="gap-4 border-b-0 bg-transparent px-0 py-0 h-10 max-md:w-full">
                <Tabs.Trigger value="overview" class="text-12-regular">Overview</Tabs.Trigger>
                <Tabs.Trigger value="processes" class="text-12-regular">Processes</Tabs.Trigger>
              </Tabs.List>
            </div>

            {/* ── Overview ── */}
            <Tabs.Content value="overview" class="min-h-0 flex-1 overflow-auto">
              <div class="flex flex-col gap-4 px-5 py-4 max-md:px-3 max-md:py-3">
                {/* Metrics strip */}
                <div class="grid grid-cols-4 overflow-hidden rounded-lg border border-border-weak-base max-md:grid-cols-2">
                  <MetricCell
                    label="Active"
                    value={String(summary().current.groups)}
                    sub={`${summary().current.rows} proc · ${formatMB(summary().current.rss_kb)}`}
                    tone={summary().current.problem_children > 0 ? "warn" : summary().current.groups > 0 ? "ok" : undefined}
                  />
                  <MetricCell
                    label="Stale"
                    value={String(summary().leaked.groups)}
                    sub={summary().leaked.groups > 0 ? `${summary().leaked.rows} proc · ${formatMB(summary().leaked.rss_kb)}` : "All clear"}
                    tone={summary().leaked.groups > 0 ? "danger" : undefined}
                  />
                  <MetricCell
                    label="External"
                    value={String(summary().external.groups)}
                    sub={summary().external.groups > 0 ? `${summary().external.rows} processes` : "None detected"}
                    tone={summary().external.groups > 0 ? "warn" : undefined}
                  />
                  <MetricCell
                    label="Runtime"
                    value={data()?.server ? formatUptimeSeconds(data()!.server.uptime_s) : "--"}
                    sub={`RSS ${formatMB(data()?.server?.rss_kb ?? 0)} · ${claimedPorts().size} ports`}
                  />
                </div>

                {/* Active workloads */}
                <ProcessSection title="Active workloads" detail={`${owners().length} groups`}>
                  <Show
                    when={owners().length > 0}
                    fallback={<div class="px-4 py-5 text-center text-[12px] text-text-weak">No active workloads</div>}
                  >
                    <For each={owners()}>
                      {(group) => (
                        <GroupRow
                          group={group}
                          workspace={workspace(group)}
                          open={!!open()[group.key]}
                          busy={!!busy()[`group:${group.key}`]}
                          onToggle={() => toggle(group.key)}
                          onOpen={group.terminal_id ? () => openGroup(group) : undefined}
                          onStop={
                            group.process_id
                              ? () => void run(`group:${group.key}`, () => terminate({ process_id: group.process_id }))
                              : undefined
                          }
                        />
                      )}
                    </For>
                  </Show>
                </ProcessSection>

                {/* Stale cleanup */}
                <Show when={leaks().length > 0}>
                  <ProcessSection
                    title="Stale"
                    detail={`${leaks().length} groups · ${formatMB(summary().leaked.rss_kb)}`}
                    action={
                      <Button
                        variant="ghost"
                        size="small"
                        icon="trash"
                        disabled={!!busy()["kill-leaks"]}
                        onClick={() =>
                          void run("kill-leaks", () =>
                            Promise.all(
                              leaks().map((group) => terminate({ group_key: group.key, scope: group.target?.scope })),
                            ).then(() => {}),
                          )
                        }
                      >
                        Clean all
                      </Button>
                    }
                  >
                    <For each={leaks()}>
                      {(group) => (
                        <GroupRow
                          group={group}
                          open={!!open()[group.key]}
                          busy={!!busy()[`group:${group.key}`]}
                          onToggle={() => toggle(group.key)}
                          onKill={() =>
                            void run(`group:${group.key}`, () =>
                              terminate({ group_key: group.key, scope: group.target?.scope }),
                            )
                          }
                        />
                      )}
                    </For>
                  </ProcessSection>
                </Show>

                {/* External servers */}
                <Show when={other().length > 0}>
                  <ProcessSection title="Other servers" detail={`${other().length} groups`}>
                    <For each={other()}>
                      {(group) => (
                        <GroupRow
                          group={group}
                          open={!!open()[group.key]}
                          busy={false}
                          onToggle={() => toggle(group.key)}
                        />
                      )}
                    </For>
                  </ProcessSection>
                </Show>
              </div>
            </Tabs.Content>

            {/* ── Processes ── */}
            <Tabs.Content value="processes" class="min-h-0 flex-1 overflow-hidden">
              <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
                {/* Filter bar */}
                <div class="flex flex-wrap items-center justify-between gap-2 border-b border-border-weak-base px-5 py-2 max-md:px-3">
                  <div class="flex flex-wrap items-center gap-1 max-md:w-full max-md:overflow-x-auto max-md:flex-nowrap">
                    <For each={filterOptions}>
                      {(opt) => {
                        const count = () => filterCount(opt.value)
                        return (
                          <Tooltip placement="top" inactive={!opt.hint} value={<span class="text-[11px] max-w-[240px]">{opt.hint}</span>}>
                            <button
                              type="button"
                              class={`shrink-0 rounded-md px-2.5 py-1 text-[12px] transition-colors ${
                                osFilter() === opt.value
                                  ? "bg-surface-base-hover text-text-strong font-medium"
                                  : "text-text-weak hover:text-text-base hover:bg-surface-base-hover/50"
                              }`}
                              onClick={() => setOsFilter(opt.value)}
                            >
                              {opt.label}
                              <span class="ml-1 text-text-weak/60">{count()}</span>
                            </button>
                          </Tooltip>
                        )
                      }}
                    </For>
                  </div>
                  <Show when={staleRows().length > 0}>
                    <Button
                      variant="ghost"
                      size="small"
                      icon="trash"
                      disabled={!!busy()["kill-stale"]}
                      onClick={() =>
                        void run("kill-stale", () =>
                          Promise.all(staleRows().map((row) => terminate({ pid: row.pid }))).then(() => {}),
                        )
                      }
                    >
                      Kill {staleRows().length} stale
                    </Button>
                  </Show>
                </div>

                {/* Table */}
                <div class="min-h-0 flex-1 overflow-auto">
                  <Show
                    when={filteredOsRows().length > 0}
                    fallback={<div class="px-5 py-8 text-center text-[13px] text-text-weak">No processes match this filter.</div>}
                  >
                    <div class="hidden flex-col gap-2 p-3 max-md:flex">
                      <For each={filteredOsRows()}>
                        {(row) => {
                          const item = linkedResource(row)
                          const processId = managedId(row)
                          return (
                            <ProcessCard
                              row={row}
                              title={item?.title}
                              source={row.mcp_name || row.process_id || row.terminal_id}
                              processId={processId}
                              terminalId={item?.terminalId}
                              busy={busy()}
                              onOpen={() => openLinkedTerminal(row)}
                              onStop={processId ? () => void run(`stop-os:${row.pid}`, () => terminate({ process_id: processId })) : undefined}
                              onKill={() => void run(`kill:${row.pid}`, () => terminate({ pid: row.pid }))}
                            />
                          )
                        }}
                      </For>
                    </div>
                    <table class="min-w-[1200px] w-full text-left text-[12px] max-md:hidden">
                      <thead class="sticky top-0 z-10 bg-surface-raised-stronger-non-alpha">
                        <tr class="border-b border-border-weak-base text-[11px] uppercase tracking-wide text-text-weak">
                          <th class="px-5 py-2 font-medium w-20">PID</th>
                          <th class="px-3 py-2 font-medium w-20">Status</th>
                          <th class="px-3 py-2 font-medium w-36">Source</th>
                          <th class="px-3 py-2 font-medium">Command</th>
                          <th class="px-3 py-2 font-medium w-14 text-right">Age</th>
                          <th class="px-3 py-2 font-medium w-14 text-right">CPU</th>
                          <th class="px-3 py-2 font-medium w-16 text-right">Mem</th>
                          <th class="px-3 py-2 font-medium w-14 text-right">Port</th>
                          <th class="px-5 py-2 font-medium w-28 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        <For each={filteredOsRows()}>
                          {(row) => {
                            const item = linkedResource(row)
                            const processId = managedId(row)
                            return (
                              <tr class="group border-b border-border-weak-base/50 transition-colors hover:bg-surface-base-hover/30">
                                <td class="px-5 py-2 font-mono text-[12px]">
                                  <span class="text-text-strong">{row.pid}</span>
                                  <Show when={row.ppid > 1}>
                                    <span class="ml-1 text-[10px] text-text-weak/50" title={`Parent: ${row.ppid}`}>&larr;{row.ppid}</span>
                                  </Show>
                                </td>
                                <td class="px-3 py-2">
                                  <div class="flex items-center gap-1.5">
                                    <StatusPill value={row.status} />
                                  </div>
                                </td>
                                <td class="px-3 py-2">
                                  <Show
                                    when={item?.title}
                                    fallback={
                                      <span class="font-mono text-[11px] text-text-weak/50" title={row.mcp_name || row.process_id || row.terminal_id}>
                                        {row.mcp_name
                                          ? clipped(row.mcp_name, 20)
                                          : row.process_id
                                            ? clipped(row.process_id, 20)
                                            : row.terminal_id
                                              ? clipped(row.terminal_id, 20)
                                              : "--"}
                                      </span>
                                    }
                                  >
                                    <span class="text-text-base">{item!.title}</span>
                                  </Show>
                                </td>
                                <td class="px-3 py-2 max-w-[280px] truncate font-mono text-[11px] text-text-weak" title={row.command_short}>
                                  {row.command_short}
                                </td>
                                <td class="px-3 py-2 text-right text-text-weak tabular-nums" title={row.elapsed}>{formatAge(row.elapsed)}</td>
                                <td class="px-3 py-2 text-right text-text-weak tabular-nums">{formatCPU(row.cpu_percent)}</td>
                                <td class="px-3 py-2 text-right text-text-weak tabular-nums">{formatMB(row.rss_kb)}</td>
                                <td class="px-3 py-2 text-right text-text-weak tabular-nums">{row.port ?? <span class="text-text-weak/50">--</span>}</td>
                                <td class="px-5 py-2 text-right">
                                  <div class="flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                                    <Show when={item?.terminalId}>
                                      <Button variant="ghost" size="small" icon="console" onClick={() => openLinkedTerminal(row)}>
                                        Open
                                      </Button>
                                    </Show>
                                    <Show when={processId}>
                                      <Button
                                        variant="ghost"
                                        size="small"
                                        icon="stop"
                                        disabled={!!busy()[`stop-os:${row.pid}`]}
                                        onClick={() => void run(`stop-os:${row.pid}`, () => terminate({ process_id: processId }))}
                                      >
                                        Stop
                                      </Button>
                                    </Show>
                                    <Button
                                      variant="ghost"
                                      size="small"
                                      icon="trash"
                                      disabled={!!busy()[`kill:${row.pid}`]}
                                      onClick={() => void run(`kill:${row.pid}`, () => terminate({ pid: row.pid }))}
                                    >
                                      Kill
                                    </Button>
                                  </div>
                                </td>
                              </tr>
                            )
                          }}
                        </For>
                      </tbody>
                    </table>
                  </Show>
                </div>
              </div>
            </Tabs.Content>
          </Tabs>
        </Show>
      </div>
    </Dialog>
  )
}

/* ─── Sub-components ─── */

function ProcessCard(props: {
  row: OsRow
  title?: string
  source?: string
  processId?: string
  terminalId?: string
  busy: Partial<Record<string, boolean>>
  onOpen: () => void
  onStop?: () => void
  onKill: () => void
}) {
  return (
    <div class="rounded-lg border border-border-weak-base bg-surface-raised-base p-3">
      <div class="flex items-start gap-2">
        <div class="min-w-0 flex-1">
          <div class="flex min-w-0 items-center gap-2">
            <span class="font-mono text-[12px] text-text-strong">{props.row.pid}</span>
            <StatusPill value={props.row.status} />
            <Show when={props.row.ppid > 1}>
              <span class="text-[10px] text-text-weak/60">parent {props.row.ppid}</span>
            </Show>
          </div>
          <div class="mt-2 min-w-0 truncate text-[13px] font-medium text-text-base">
            {props.title || props.source || "Process"}
          </div>
          <div class="mt-1 line-clamp-2 break-all font-mono text-[11px] leading-4 text-text-weak">
            {props.row.command_short}
          </div>
        </div>
        <Show when={props.row.port}>
          {(port) => <span class="shrink-0 rounded bg-surface-base-hover px-1.5 py-0.5 font-mono text-[11px] text-text-weak">:{port()}</span>}
        </Show>
      </div>

      <div class="mt-3 grid grid-cols-3 gap-2 text-[11px] text-text-weak">
        <div>
          <div class="text-[10px] uppercase text-text-weak/60">Age</div>
          <div class="mt-0.5 tabular-nums">{formatAge(props.row.elapsed)}</div>
        </div>
        <div>
          <div class="text-[10px] uppercase text-text-weak/60">CPU</div>
          <div class="mt-0.5 tabular-nums">{formatCPU(props.row.cpu_percent)}</div>
        </div>
        <div>
          <div class="text-[10px] uppercase text-text-weak/60">Mem</div>
          <div class="mt-0.5 tabular-nums">{formatMB(props.row.rss_kb)}</div>
        </div>
      </div>

      <Show when={props.row.reasons.length > 0}>
        <div class="mt-2 rounded-md bg-surface-warning-base/10 px-2 py-1.5 text-[11px] text-text-on-warning-base">
          {props.row.reasons.map(reasonLabel).join(", ")}
        </div>
      </Show>

      <div class="mt-3 flex flex-wrap justify-end gap-1">
        <Show when={props.terminalId}>
          <Button variant="ghost" size="small" icon="console" onClick={props.onOpen}>
            Open
          </Button>
        </Show>
        <Show when={props.onStop}>
          {(onStop) => (
            <Button variant="ghost" size="small" icon="stop" disabled={!!props.busy[`stop-os:${props.row.pid}`]} onClick={onStop()}>
              Stop
            </Button>
          )}
        </Show>
        <Button variant="ghost" size="small" icon="trash" disabled={!!props.busy[`kill:${props.row.pid}`]} onClick={props.onKill}>
          Kill
        </Button>
      </div>
    </div>
  )
}

function MetricCell(props: {
  label: string
  value: string
  sub: string
  tone?: "ok" | "warn" | "danger"
}) {
  const accent = () => {
    if (props.tone === "ok") return "text-text-on-success-base"
    if (props.tone === "warn") return "text-text-on-warning-base"
    if (props.tone === "danger") return "text-text-on-critical-base"
    return "text-text-strong"
  }

  return (
    <div class="border-r border-border-weak-base bg-surface-raised-base px-4 py-3 last:border-r-0 max-md:border-b max-md:[&:nth-child(2n)]:border-r-0 max-md:[&:nth-last-child(-n+2)]:border-b-0 max-md:px-3">
      <div class="text-[11px] font-medium uppercase tracking-wide text-text-weak">{props.label}</div>
      <div class={`mt-1 text-[20px] font-medium tabular-nums leading-tight ${accent()}`}>{props.value}</div>
      <div class="mt-1 text-[11px] text-text-weak">{props.sub}</div>
    </div>
  )
}

function ProcessSection(props: {
  title: string
  detail: string
  action?: JSX.Element
  children: JSX.Element
}) {
  return (
    <div class="overflow-hidden rounded-lg border border-border-weak-base">
      <div class="flex items-center justify-between gap-3 bg-surface-raised-base px-4 py-2.5 max-md:px-3">
        <div class="flex min-w-0 items-center gap-2.5 max-md:flex-col max-md:items-start max-md:gap-0.5">
          <span class="text-[13px] font-medium text-text-strong">{props.title}</span>
          <span class="text-[11px] text-text-weak">{props.detail}</span>
        </div>
        <Show when={props.action}>
          <div class="shrink-0">{props.action}</div>
        </Show>
      </div>
      <div class="divide-y divide-border-weak-base/40">{props.children}</div>
    </div>
  )
}

function GroupRow(props: {
  group: Group
  workspace?: string
  open: boolean
  busy: boolean
  onToggle: () => void
  onOpen?: () => void
  onStop?: () => void
  onKill?: () => void
}) {
  const visibleRows = () =>
    props.open
      ? props.group.children
      : props.group.children.filter((row) => !row.hidden_by_default && (row.depth > 0 || row.status !== "active" || row.reasons.length > 0))

  const hiddenCount = () => props.group.children.length - visibleRows().length
  const canExpand = () => props.group.hidden_children > 0 || props.group.children.some((row) => row.depth > 0)
  const killText = () => (props.group.kind === "leaked_server" ? "Clean up" : "Kill")

  return (
    <div class="group/row">
      {/* Main row */}
      <div class="flex items-center gap-2 px-4 py-2.5 transition-colors hover:bg-surface-base-hover/30 max-md:flex-wrap max-md:px-3">
        <StatusDot status={props.group.status} />
        <span class={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium leading-none ${kindTone(props.group.kind)}`}>
          {kindLabel(props.group.kind)}
        </span>
        <span class="min-w-0 flex-1 truncate text-[13px] font-medium text-text-strong">{props.group.title}</span>

        <Show when={props.group.problem_children > 0}>
          <span class="shrink-0 text-[10px] font-medium text-text-on-warning-base">{props.group.problem_children} issues</span>
        </Show>

        <div class="flex-1 max-md:hidden" />

        <Show when={props.group.ports.length > 0}>
          <span class="shrink-0 font-mono text-[11px] text-text-weak">:{props.group.ports.join(", :")}</span>
        </Show>
        <span class="w-12 shrink-0 text-right text-[12px] tabular-nums text-text-weak max-md:w-auto">{formatCPU(props.group.cpu_percent)}</span>
        <span class="w-16 shrink-0 text-right text-[12px] tabular-nums text-text-weak max-md:w-auto">{formatMB(props.group.rss_kb)}</span>

        {/* Hover actions */}
        <div class="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100 max-md:basis-full max-md:opacity-100">
          <Show when={props.onOpen}>
            <Button variant="ghost" size="small" icon="console" onClick={props.onOpen}>
              Open
            </Button>
          </Show>
          <Show when={props.onStop}>
            <Button variant="ghost" size="small" icon="stop" disabled={props.busy} onClick={props.onStop}>
              Stop
            </Button>
          </Show>
          <Show when={props.onKill}>
            <Button variant="ghost" size="small" icon="trash" disabled={props.busy} onClick={props.onKill}>
              {killText()}
            </Button>
          </Show>
        </div>

        <Show when={canExpand()}>
          <button
            type="button"
            class="shrink-0 rounded p-1 text-text-weak transition-colors hover:bg-surface-base-hover hover:text-text-base"
            onClick={props.onToggle}
          >
            <Icon name="chevron-down" size="small" class={`transition-transform ${props.open ? "rotate-180" : ""}`} />
          </button>
        </Show>
      </div>

      {/* Children */}
      <Show when={visibleRows().length > 0 || (canExpand() && !props.open)}>
        <div class="ml-5 border-l border-border-weak-base/60 max-md:ml-3">
          <For each={visibleRows()}>{(row) => <ChildRow row={row} />}</For>
          <Show when={canExpand() && hiddenCount() > 0}>
            <button
              type="button"
              class="w-full px-3 py-1.5 text-left text-[11px] text-text-weak transition-colors hover:text-text-base"
              onClick={props.onToggle}
            >
              {props.open ? "Hide helpers" : `+${hiddenCount()} hidden`}
            </button>
          </Show>
        </div>
      </Show>
    </div>
  )
}

function ChildRow(props: { row: OsRow }) {
  return (
    <div class="flex items-center gap-2 px-3 py-1.5 text-[11px] max-md:flex-wrap">
      <span class="w-12 shrink-0 font-mono text-text-weak">{props.row.pid}</span>
      <StatusDot status={props.row.status} />
      <Show when={props.row.mcp_name}>
        {(name) => (
          <span class="shrink-0 rounded bg-surface-info-base/10 px-1.5 py-0.5 text-[10px] font-medium text-text-on-info-base">
            MCP {name()}
          </span>
        )}
      </Show>
      <span class="min-w-0 flex-1 truncate font-mono text-text-weak max-md:basis-full" title={props.row.command_short}>
        {clipped(props.row.command_short, 60)}
      </span>
      <Show when={props.row.reasons.length > 0}>
        <span class="shrink-0 text-text-weak/70">{props.row.reasons.map(reasonLabel).join(", ")}</span>
      </Show>
      <div class="flex-1" />
      <span class="w-16 shrink-0 text-right tabular-nums text-text-weak">{formatMB(props.row.rss_kb)}</span>
      <span class="w-10 shrink-0 text-right text-text-weak">{formatAge(props.row.elapsed)}</span>
    </div>
  )
}
