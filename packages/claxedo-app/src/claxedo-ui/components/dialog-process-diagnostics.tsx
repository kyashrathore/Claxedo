import { For, Show, createMemo, createSignal, onMount } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { showToast } from "@opencode-ai/ui/toast"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { usePlatform } from "@/context/platform"
import { useGlobalSDK, useServer } from "@opencode-ai/claxedo-app"
import { useClaxedoLayout } from "../context/claxedo-layout"
import type { Process } from "../../opencode-patches/process/process"
import {
  buildProcessDiagnosisPrompt,
  PROCESS_DIAGNOSIS_MODEL,
  PROCESS_DIAGNOSIS_SYSTEM,
} from "../utils/process-diagnosis-session"
import { collapse, clip, formatMB, formatCPU, errorText } from "../utils/text"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { Icon } from "@opencode-ai/ui/icon"

type Snapshot = Process.DiagnosticSnapshot
type OsRow = Process.DiagnosticOsProcess
type OsFilter = "all" | "managed" | Process.DiagnosticStatus

type ResourceRow = {
  key: string
  kind: "managed" | "terminal"
  title: string
  directory: string
  terminalId?: string
  processId?: string
  tabId?: string
  groupId?: string
  cpu: number
  rssKb: number
  os: OsRow[]
  status: string
}

const DIAGNOSIS_TITLE = "Process Diagnosis"

const score = (status: string) => (status === "stale" ? 3 : status === "suspect" ? 2 : status === "running" ? 1 : 0)
const clipped = (value: string | undefined, max = 180) => clip(collapse(value), max)

/** Convert ps etime format (MM:SS, HH:MM:SS, DD-HH:MM:SS) to human-readable. */
function formatAge(elapsed: string) {
  const dayMatch = elapsed.match(/^(\d+)-(\d+):(\d+):(\d+)$/)
  if (dayMatch) {
    const d = Number(dayMatch[1])
    const h = Number(dayMatch[2])
    return h > 0 ? `${d}d ${h}h` : `${d}d`
  }
  const hmsMatch = elapsed.match(/^(\d+):(\d+):(\d+)$/)
  if (hmsMatch) {
    const h = Number(hmsMatch[1])
    const m = Number(hmsMatch[2])
    return m > 0 ? `${h}h ${m}m` : `${h}h`
  }
  const msMatch = elapsed.match(/^(\d+):(\d+)$/)
  if (msMatch) {
    const m = Number(msMatch[1])
    const s = Number(msMatch[2])
    return m > 0 ? `${m}m ${s}s` : `${s}s`
  }
  return elapsed
}

function formatUptimeSeconds(s: number) {
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`
  return `${m}m`
}

function reasonLabel(value: string) {
  if (value === "missing-pty") return "Orphaned terminal"
  if (value === "dead-port") return "Port not listening"
  if (value === "bad-state") return "Unhealthy state"
  if (value === "long-running") return "Running 7+ days"
  return value
}

function StatusPill(props: { value: string }) {
  const tone = () => {
    if (props.value === "stale" || props.value === "crashed") return "bg-red-500/15 text-red-500"
    if (props.value === "suspect" || props.value === "restarting" || props.value === "starting") {
      return "bg-amber-500/15 text-amber-600"
    }
    if (props.value === "running" || props.value === "active") return "bg-green-500/15 text-green-600"
    return "bg-surface-base-hover text-text-weak"
  }

  return (
    <span class={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${tone()}`}>
      {props.value}
    </span>
  )
}

export function DialogProcessDiagnostics(props: { directory?: string }) {
  const dialog = useDialog()
  const globalSDK = useGlobalSDK()
  const platform = usePlatform()
  const server = useServer()
  const claxedo = useClaxedoLayout()
  const fetchFn = platform.fetch ?? globalThis.fetch

  const [data, setData] = createSignal<Snapshot>()
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string>()
  const [busy, setBusy] = createSignal<Record<string, boolean>>({})
  const [osFilter, setOsFilter] = createSignal<OsFilter>("all")

  const activeDirectory = () => props.directory || ""
  let abortCtrl: AbortController | undefined

  const load = async () => {
    if (!server.url) return
    abortCtrl?.abort()
    abortCtrl = new AbortController()
    const { signal } = abortCtrl
    setLoading(true)
    setError(undefined)
    try {
      const res = await fetchFn(`${server.url}/process/diagnostics`, {
        signal,
        headers: activeDirectory()
          ? { "x-opencode-directory": activeDirectory() }
          : undefined,
      })
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      setData((await res.json()) as Snapshot)
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
    const byTerminal = new Map<string, { tabId: string; title: string; groupId: string; directory: string }>()
    const bySession = new Map<string, { tabId: string; title: string; groupId: string; directory: string }>()
    for (const group of claxedo.split.groups()) {
      for (const tab of group.tabs.items) {
        if (tab.type === "terminal" && tab.terminalId) {
          byTerminal.set(tab.terminalId, {
            tabId: tab.id,
            title: tab.title,
            groupId: group.id,
            directory: tab.directory,
          })
        }
        if (tab.sessionId) {
          bySession.set(`${tab.directory}:${tab.sessionId}`, {
            tabId: tab.id,
            title: tab.title,
            groupId: group.id,
            directory: tab.directory,
          })
        }
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
        tabId: tab?.tabId,
        groupId: tab?.groupId,
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
        tabId: tab?.tabId,
        groupId: tab?.groupId,
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
  const staleRows = createMemo(() => osRows().filter((row) => row.status === "stale"))

  const focusTab = (groupId: string | undefined, tabId: string | undefined) => {
    if (!groupId || !tabId) return false
    claxedo.dispatch({ type: "SplitFocusRequested", groupId })
    claxedo.groupTabs(groupId).setActive(tabId)
    return true
  }

  const openTerminal = (row: ResourceRow) => {
    if (focusTab(row.groupId, row.tabId)) return
    if (!row.terminalId) return
    const groupId = claxedo.split.focusedId()
    const tabsApi = groupId ? claxedo.groupTabs(groupId) : claxedo.topTabs
    const tabId = tabsApi.addTerminal(row.directory || activeDirectory(), row.terminalId, row.title)
    if (tabId) tabsApi.setActive(tabId)
  }

  const openWorkspaceSession = (directory: string, sessionId: string, title: string) => {
    const key = `${directory}:${sessionId}`
    const existing = tabs().bySession.get(key)
    if (focusTab(existing?.groupId, existing?.tabId)) return existing?.tabId
    const groupId = claxedo.split.focusedId()
    const tabsApi = groupId ? claxedo.groupTabs(groupId) : claxedo.topTabs
    const tabId = tabsApi.addSession(directory, sessionId, title)
    if (tabId) tabsApi.setActive(tabId)
    return tabId
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

  const managedId = (row: OsRow) => {
    const item = linkedResource(row)
    if (item?.processId) return item.processId
    if (row.process_id && indexes().configById.has(row.process_id)) return row.process_id
  }

  const managedRow = (row: OsRow) => !!managedId(row)

  const filteredOsRows = createMemo(() => {
    const value = osFilter()
    if (value === "all") return osRows()
    if (value === "managed") return osRows().filter(managedRow)
    return osRows().filter((row) => row.status === value)
  })

  const diagnose = async () => {
    const snapshot = data()
    const directory = activeDirectory() || snapshot?.directory
    if (!snapshot || !directory) return

    setBusy((prev) => ({ ...prev, ai: true }))
    try {
      const client = globalSDK.createClient({
        directory,
        throwOnError: true,
      })
      const created = await client.session.create({
        title: DIAGNOSIS_TITLE,
      })
      const sessionId = created.data?.id
      if (!sessionId) throw new Error("Failed to create diagnosis session")

      openWorkspaceSession(directory, sessionId, DIAGNOSIS_TITLE)
      dialog.close()

      const prompt = await buildProcessDiagnosisPrompt({
        sdkUrl: globalSDK.url,
        snapshot,
      })

      void client.session.promptAsync({
        sessionID: sessionId,
        model: PROCESS_DIAGNOSIS_MODEL,
        system: PROCESS_DIAGNOSIS_SYSTEM,
        parts: [{ type: "text", text: prompt }],
      }).catch((err) => {
        showToast({
          title: "AI diagnosis failed",
          description: errorText(err),
          variant: "error",
        })
      })
    } catch (err) {
      showToast({
        title: "AI diagnosis failed",
        description: errorText(err),
        variant: "error",
      })
    } finally {
      setBusy((prev) => ({ ...prev, ai: false }))
    }
  }

  const terminate = async (input: { pid?: number; pty_id?: string; process_id?: string; signal?: "SIGTERM" | "SIGKILL" }) => {
    const res = await fetchFn(`${server.url}/process/diagnostics/terminate`, {
      method: "POST",
      headers: activeDirectory()
        ? {
            "Content-Type": "application/json",
            "x-opencode-directory": activeDirectory(),
          }
        : { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  }

  const osSummary = createMemo(() => {
    let active = 0, suspect = 0, staleCount = 0, staleRss = 0, totalRss = 0
    for (const row of osRows()) {
      totalRss += row.rss_kb
      if (row.status === "active") active++
      else if (row.status === "suspect") suspect++
      else if (row.status === "stale") { staleCount++; staleRss += row.rss_kb }
    }
    const server = data()?.server
    const serverRss = server?.rss_kb ?? 0
    return { active, suspect, staleCount, staleRss, totalRss, serverRss }
  })

  const claimedPorts = createMemo(() => {
    const ports = new Set<number>()
    const listening = new Set(data()?.listening_ports ?? [])
    for (const row of osRows()) {
      if (row.port != null && listening.has(row.port)) ports.add(row.port)
    }
    return ports
  })

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

  return (
    <Dialog title="Process Diagnostics" size="full">
      <div class="flex h-full min-h-0 flex-col overflow-hidden">
        {/* ── Header bar ── */}
        <div class="flex items-center justify-between gap-3 px-5 pb-4">
          <div class="min-w-0 text-[13px] text-text-weak truncate">
            All processes spawned by this server
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <Button variant="secondary" size="small" icon="brain" disabled={loading() || !!busy().ai} onClick={() => void diagnose()}>
              AI Diagnosis
            </Button>
            <Button variant="ghost" size="small" disabled={loading()} onClick={() => void load()}>
              Refresh
            </Button>
          </div>
        </div>

        <Show when={error()}>
          {(value) => (
            <div class="mx-5 mb-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-500">
              {value()}
            </div>
          )}
        </Show>

        <Show when={!loading()} fallback={<div class="py-12 text-center text-[13px] text-text-weak">Loading...</div>}>
          <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
            {/* ── Summary stats ── */}
            <div class="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-border-weak-base px-5 pb-3">
              <StatMB label="Total memory" valueKb={osSummary().serverRss + osSummary().totalRss} />
              <Show when={data()?.server}>
                {(server) => (
                  <>
                    <StatMB label="Server RSS" valueKb={server().rss_kb} />
                    <StatMB label="Heap used" valueKb={server().heap_used_kb} />
                    <StatText label="Uptime" value={formatUptimeSeconds(server().uptime_s)} />
                  </>
                )}
              </Show>
              <StatMB label="Child processes" valueKb={osSummary().totalRss} />
              <div class="h-4 w-px bg-border-weak-base" />
              <Stat label="Tracked" value={trackedResources().length} />
              <Stat label="OS processes" value={osRows().length} />
              <Show when={osSummary().active > 0}>
                <Stat label="Active" value={osSummary().active} tone="green" />
              </Show>
              <Show when={osSummary().suspect > 0}>
                <Stat label="Suspect" value={osSummary().suspect} tone="amber" />
              </Show>
              <Show when={osSummary().staleCount > 0}>
                <Stat label="Stale" value={osSummary().staleCount} detail={formatMB(osSummary().staleRss)} tone="red" />
              </Show>
              <Show when={claimedPorts().size > 0}>
                <Stat label="Listening ports" value={claimedPorts().size} />
              </Show>
            </div>

            {/* ── Filter bar ── */}
            <div class="flex flex-wrap items-center justify-between gap-2 border-b border-border-weak-base px-5 py-2">
              <div class="flex flex-wrap items-center gap-1">
                <For each={filterOptions}>
                  {(opt) => {
                    const count = () => filterCount(opt.value)
                    return (
                      <Tooltip placement="top" inactive={!opt.hint} value={<span class="text-[11px] max-w-[240px]">{opt.hint}</span>}>
                        <button
                          type="button"
                          class={`rounded-md px-2.5 py-1 text-[12px] transition-colors ${
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

            {/* ── Table ── */}
            <div class="min-h-0 flex-1 overflow-auto">
              <Show
                when={filteredOsRows().length > 0}
                fallback={
                  <div class="px-5 py-8 text-center text-[13px] text-text-weak">
                    No processes match this filter.
                  </div>
                }
              >
                <table class="min-w-[1400px] w-full text-left text-[12px]">
                  <thead class="sticky top-0 z-10 bg-surface-raised-stronger-non-alpha">
                    <tr class="border-b border-border-weak-base text-[11px] uppercase tracking-wide text-text-weak">
                      <th class="px-5 py-2.5 font-medium">PID</th>
                      <th class="px-3 py-2.5 font-medium">
                        <span class="inline-flex items-center">Status<HeaderHint hint="Active = running normally. Suspect = unhealthy OS state or running 7+ days. Stale = orphaned or dead port." /></span>
                      </th>
                      <th class="px-3 py-2.5 font-medium">
                        <span class="inline-flex items-center">Reason<HeaderHint hint="Why a process was flagged as stale or suspect." /></span>
                      </th>
                      <th class="px-3 py-2.5 font-medium">
                        <span class="inline-flex items-center">Source<HeaderHint hint="The managed process or terminal this OS process belongs to." /></span>
                      </th>
                      <th class="px-3 py-2.5 font-medium">
                        <span class="inline-flex items-center">Command<HeaderHint hint="The actual binary and arguments running in this OS process." /></span>
                      </th>
                      <th class="px-3 py-2.5 font-medium">Age</th>
                      <th class="px-3 py-2.5 font-medium">CPU</th>
                      <th class="px-3 py-2.5 font-medium">Memory</th>
                      <th class="px-3 py-2.5 font-medium">Port</th>
                      <th class="px-5 py-2.5 font-medium text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={filteredOsRows()}>
                      {(row) => {
                        const item = linkedResource(row)
                        const processId = managedId(row)
                        return (
                          <tr class="group border-b border-border-weak-base/50 transition-colors hover:bg-surface-base-hover/30">
                            <td class="px-5 py-2.5 font-mono text-[12px]">
                              <span class="text-text-strong">{row.pid}</span>
                              <Show when={row.ppid > 1}>
                                <span class="ml-1 text-[10px] text-text-weak/50" title={`Parent PID: ${row.ppid}`}>&larr;{row.ppid}</span>
                              </Show>
                            </td>
                            <td class="px-3 py-2.5">
                              <StatusPill value={row.status} />
                            </td>
                            <td class="px-3 py-2.5 text-text-weak">
                              <Show when={row.reasons.length > 0} fallback={<span class="text-text-weak/50">--</span>}>
                                <span>{row.reasons.map(reasonLabel).join(", ")}</span>
                              </Show>
                            </td>
                            <td class="px-3 py-2.5">
                              <Show when={item?.title} fallback={
                                <span class="font-mono text-[11px] text-text-weak/50" title={row.process_id || row.terminal_id}>
                                  {row.process_id ? clipped(row.process_id, 20) : row.terminal_id ? clipped(row.terminal_id, 20) : "--"}
                                </span>
                              }>
                                <span class="text-text-base">{item!.title}</span>
                              </Show>
                            </td>
                            <td class="px-3 py-2.5 max-w-[260px] truncate font-mono text-[11px] text-text-weak" title={row.command_short}>
                              {row.command_short}
                            </td>
                            <td class="px-3 py-2.5 text-text-weak" title={row.elapsed}>{formatAge(row.elapsed)}</td>
                            <td class="px-3 py-2.5 text-text-weak tabular-nums">{formatCPU(row.cpu_percent)}</td>
                            <td class="px-3 py-2.5 text-text-weak tabular-nums">{formatMB(row.rss_kb)}</td>
                            <td class="px-3 py-2.5 text-text-weak tabular-nums">{row.port ?? <span class="text-text-weak/50">--</span>}</td>
                            <td class="px-5 py-2.5 text-right">
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
        </Show>
      </div>
    </Dialog>
  )
}

function Stat(props: { label: string; value: number; detail?: string; tone?: "green" | "amber" | "red" }) {
  const color = () => {
    if (props.tone === "green") return "text-green-600"
    if (props.tone === "amber") return "text-amber-600"
    if (props.tone === "red") return "text-red-500"
    return "text-text-strong"
  }

  return (
    <div class="flex items-baseline gap-1.5">
      <span class={`text-[16px] font-medium tabular-nums ${color()}`}>{props.value}</span>
      <span class="text-[12px] text-text-weak">{props.label}</span>
      <Show when={props.detail}>
        <span class="text-[11px] text-text-weak/60">({props.detail})</span>
      </Show>
    </div>
  )
}

function StatMB(props: { label: string; valueKb: number }) {
  return (
    <div class="flex items-baseline gap-1.5">
      <span class="text-[16px] font-medium tabular-nums text-text-strong">{formatMB(props.valueKb)}</span>
      <span class="text-[12px] text-text-weak">{props.label}</span>
    </div>
  )
}

function StatText(props: { label: string; value: string }) {
  return (
    <div class="flex items-baseline gap-1.5">
      <span class="text-[16px] font-medium text-text-strong">{props.value}</span>
      <span class="text-[12px] text-text-weak">{props.label}</span>
    </div>
  )
}

function HeaderHint(props: { hint: string }) {
  return (
    <Tooltip placement="top" value={<span class="text-[11px]">{props.hint}</span>}>
      <span class="inline-flex cursor-help text-text-weak/40 hover:text-text-weak ml-1">
        <Icon name="help" size="small" />
      </span>
    </Tooltip>
  )
}
