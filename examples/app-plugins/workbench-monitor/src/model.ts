export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

export type TabStatus = "idle" | "working" | "running_in_background" | "attention" | "interrupted" | "done" | "failed"

export type Tab = {
  readonly id: string
  readonly title: string
  readonly kind: string
  readonly status: TabStatus
  readonly active: boolean
  readonly index: number
}

export type SortKey = "index" | "title" | "status"

export type Filter = { readonly statuses: readonly TabStatus[]; readonly query: string; readonly sort: SortKey }

export const ALL_TABS: Filter = { statuses: [], query: "", sort: "index" }

export const STATUSES: readonly TabStatus[] = ["attention", "failed", "working", "running_in_background", "interrupted", "idle", "done"]

export const STATUS_LABELS: Readonly<Record<TabStatus, string>> = {
  attention: "Needs attention",
  failed: "Failed",
  working: "Working",
  running_in_background: "In background",
  interrupted: "Interrupted",
  idle: "Idle",
  done: "Done",
}

export const SORT_LABELS: Readonly<Record<SortKey, string>> = { index: "Tab order", title: "Title", status: "Status" }

export const SORT_KEYS: readonly SortKey[] = ["index", "title", "status"]

function isStatus(value: unknown): value is TabStatus {
  return typeof value === "string" && (STATUSES as readonly string[]).includes(value)
}

function isSortKey(value: unknown): value is SortKey {
  return value === "index" || value === "title" || value === "status"
}

export function readFilter(context: Readonly<Record<string, Json>>): Filter {
  const statuses = Array.isArray(context.statuses) ? context.statuses.filter(isStatus) : []
  const sort = Array.isArray(context.sort) ? context.sort[0] : context.sort
  return {
    statuses,
    query: typeof context.query === "string" ? context.query.trim() : "",
    sort: isSortKey(sort) ? sort : "index",
  }
}

function label(tab: Tab): string {
  return tab.title || "Untitled"
}

const byIndex = (a: Tab, b: Tab) => a.index - b.index

const COMPARE: Readonly<Record<SortKey, (a: Tab, b: Tab) => number>> = {
  index: byIndex,
  title: (a, b) => label(a).localeCompare(label(b), undefined, { sensitivity: "base" }) || byIndex(a, b),
  status: (a, b) => STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status) || byIndex(a, b),
}

export function visibleTabs(tabs: readonly Tab[], filter: Filter): Tab[] {
  const query = filter.query.toLowerCase()
  return tabs
    .filter((tab) => filter.statuses.length === 0 || filter.statuses.includes(tab.status))
    .filter((tab) => !query || tab.title.toLowerCase().includes(query) || tab.kind.toLowerCase().includes(query))
    .sort(COMPARE[filter.sort])
}

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger"

export const STATUS_TONES: Readonly<Record<TabStatus, Tone>> = {
  attention: "warning",
  failed: "danger",
  working: "accent",
  running_in_background: "accent",
  interrupted: "warning",
  idle: "neutral",
  done: "success",
}

export const STATUS_ICONS: Readonly<Record<TabStatus, string>> = {
  attention: "warning",
  failed: "error",
  working: "play",
  running_in_background: "fastForward",
  interrupted: "pause",
  idle: "pause",
  done: "check",
}

export type TabRow = {
  readonly id: string
  readonly title: string
  readonly subtitle: string
  readonly status: string
  readonly tone: Tone
  readonly icon: string
  readonly active: boolean
}

export function tabRow(tab: Tab): TabRow {
  return {
    id: tab.id,
    title: label(tab),
    subtitle: [`#${tab.index + 1}`, tab.kind, ...(tab.active ? ["Active"] : [])].join(" · "),
    status: STATUS_LABELS[tab.status],
    tone: STATUS_TONES[tab.status],
    icon: STATUS_ICONS[tab.status],
    active: tab.active,
  }
}

export type MonitorStats = {
  readonly open: string
  readonly focused: string
  readonly attention: string
  readonly failed: string
  readonly working: string
  readonly background: string
  readonly done: string
  readonly doneShare: string
}

export function monitorStats(tabs: readonly Tab[]): MonitorStats {
  const count = (...statuses: TabStatus[]) => tabs.filter((tab) => statuses.includes(tab.status)).length
  const active = tabs.find((tab) => tab.active)
  const done = count("done")
  return {
    open: String(tabs.length),
    focused: active ? `Focused: ${label(active)}` : "No tab focused",
    attention: String(count("attention", "failed")),
    failed: `${count("failed")} failed`,
    working: String(count("working", "running_in_background")),
    background: `${count("running_in_background")} in background`,
    done: String(done),
    doneShare: `${tabs.length === 0 ? 0 : Math.round((done / tabs.length) * 100)}% of open tabs`,
  }
}

export type Health = { readonly text: string; readonly tone: Tone }

export function monitorHealth(tabs: readonly Tab[]): Health {
  const count = (status: TabStatus) => tabs.filter((tab) => tab.status === status).length
  if (tabs.length === 0) return { text: "No tabs", tone: "neutral" }
  if (count("failed") > 0) return { text: `${count("failed")} failed`, tone: "danger" }
  if (count("attention") > 0) return { text: `${count("attention")} need${count("attention") === 1 ? "s" : ""} attention`, tone: "warning" }
  if (count("working") + count("running_in_background") > 0) return { text: "Working", tone: "accent" }
  return { text: "All clear", tone: "success" }
}

export function summaryLine(tabs: readonly Tab[], visible: number): string {
  const showing = visible === tabs.length ? "" : ` · showing ${visible}`
  return `${tabs.length} open tab${tabs.length === 1 ? "" : "s"}${showing}`
}

export function emptyMessage(tabs: readonly Tab[]): { title: string; description: string } {
  return tabs.length === 0
    ? { title: "No open tabs", description: "Open a session or a page and it appears here." }
    : { title: "No tabs match", description: "Clear the search or pick other statuses." }
}

export type Direction = "left" | "right"

export function moveTarget(tabs: readonly Tab[], tabId: string, direction: Direction): number | undefined {
  const tab = tabs.find((entry) => entry.id === tabId)
  if (!tab) return undefined
  const target = tab.index + (direction === "left" ? -1 : 1)
  return target < 0 || target >= tabs.length ? undefined : target
}

export function tabChanges(previous: readonly Tab[], next: readonly Tab[]): string[] {
  const before = new Map(previous.map((tab) => [tab.id, tab]))
  const after = new Map(next.map((tab) => [tab.id, tab]))
  const events: string[] = []
  for (const tab of next) {
    const old = before.get(tab.id)
    if (!old) {
      events.push(`Opened “${label(tab)}”`)
      continue
    }
    if (old.title !== tab.title) events.push(`“${label(old)}” renamed to “${label(tab)}”`)
    if (old.status !== tab.status) events.push(`“${label(tab)}”: ${STATUS_LABELS[old.status]} → ${STATUS_LABELS[tab.status]}`)
    if (!old.active && tab.active) events.push(`Focused “${label(tab)}”`)
  }
  for (const tab of previous) if (!after.has(tab.id)) events.push(`Closed “${label(tab)}”`)
  const kept = (tabs: readonly Tab[]) => tabs.filter((tab) => before.has(tab.id) && after.has(tab.id)).map((tab) => tab.id).join("\u0000")
  if (kept([...previous].sort(byIndex)) !== kept([...next].sort(byIndex))) events.push("Tabs reordered")
  return events
}

export type Patch = { readonly path: string; readonly value?: Json }

export function listPatches(path: string, previous: readonly Json[], next: readonly Json[]): Patch[] {
  if (previous.length !== next.length) return [{ path, value: [...next] }]
  return next.flatMap((item, index) => (JSON.stringify(item) === JSON.stringify(previous[index]) ? [] : [{ path: `${path}/${index}`, value: item }]))
}

export function recordPatches(path: string, previous: Readonly<Record<string, Json>>, next: Readonly<Record<string, Json>>): Patch[] {
  return Object.keys(next).flatMap((key) => (JSON.stringify(next[key]) === JSON.stringify(previous[key]) ? [] : [{ path: `${path}/${key}`, value: next[key]! }]))
}

export type MonitorView = {
  readonly rows: TabRow[]
  readonly stats: MonitorStats
  readonly health: Health
  readonly summary: string
  readonly empty: { title: string; description: string }
  readonly raw: string
}

export function monitorView(tabs: readonly Tab[], filter: Filter): MonitorView {
  const visible = visibleTabs(tabs, filter)
  return {
    rows: visible.map(tabRow),
    stats: monitorStats(tabs),
    health: monitorHealth(tabs),
    summary: summaryLine(tabs, visible.length),
    empty: emptyMessage(tabs),
    raw: JSON.stringify([...tabs].sort(byIndex), null, 2),
  }
}

export function viewPatches(previous: MonitorView, next: MonitorView): Patch[] {
  const scalar = (key: "summary" | "empty" | "raw"): Patch[] =>
    JSON.stringify(previous[key]) === JSON.stringify(next[key]) ? [] : [{ path: `/${key}`, value: next[key] }]
  return [
    ...listPatches("/rows", previous.rows, next.rows),
    ...recordPatches("/stats", previous.stats, next.stats),
    ...recordPatches("/health", previous.health, next.health),
    ...scalar("summary"),
    ...scalar("empty"),
    ...scalar("raw"),
  ]
}

export const ACTIVITY_LIMIT = 30

export type ActivityEntry = { readonly time: string; readonly event: string }

export function appendActivity(
  log: readonly ActivityEntry[],
  entries: readonly ActivityEntry[],
  limit = ACTIVITY_LIMIT,
): { log: ActivityEntry[]; patches: Patch[] } {
  const combined = [...log, ...entries]
  if (combined.length > limit) {
    const trimmed = combined.slice(combined.length - limit)
    return { log: trimmed, patches: [{ path: "/activity", value: trimmed }] }
  }
  return { log: combined, patches: entries.map((entry, offset) => ({ path: `/activity/${log.length + offset}`, value: entry })) }
}
