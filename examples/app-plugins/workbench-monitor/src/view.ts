import type { SurfaceComponent, SurfaceMessage } from "@claxedo/plugin-api"
import { SORT_KEYS, SORT_LABELS, STATUSES, STATUS_LABELS, type ActivityEntry, type Json, type MonitorStats, type MonitorView } from "./model"

export const CATALOG_ID = "https://claxedo.dev/a2ui/v0.9/catalog.json"

const FILTER_CONTEXT = { statuses: { path: "/statuses" }, query: { path: "/query" }, sort: { path: "/sort" } }

type IconName = Extract<SurfaceComponent, { component: "Button" }>["icon"]

function rowButton(id: string, name: string, label: string, icon?: IconName): SurfaceComponent[] {
  return [
    { id, component: "Button", ...(icon ? { icon } : {}), child: `${id}-label`, action: { event: { name, context: { id: { path: "id" } } } } },
    { id: `${id}-label`, component: "Text", text: label },
  ]
}

function stat(id: string, label: string, value: keyof MonitorStats, caption: keyof MonitorStats): SurfaceComponent {
  return { id, component: "Stat", label, value: { path: `/stats/${value}` }, caption: { path: `/stats/${caption}` } }
}

export function tabsArea(hasRows: boolean): SurfaceComponent[] {
  return [{ id: "tabs-area", component: "Column", children: hasRows ? ["tab-list"] : ["tabs-empty"] }]
}

export function activityArea(hasActivity: boolean): SurfaceComponent[] {
  return [{ id: "activity-area", component: "Column", children: hasActivity ? ["activity-table"] : ["activity-empty"] }]
}

const FIXED: SurfaceComponent[] = [
  { id: "root", component: "Column", children: ["header", "stats", "filters", "tabs", "activity", "raw"] },
  { id: "header", component: "Header", title: "Workbench monitor", subtitle: { path: "/summary" }, icon: "visibility", badges: ["health"], actions: ["refresh-button"] },
  { id: "health", component: "Badge", text: { path: "/health/text" }, variant: { path: "/health/tone" } },
  { id: "refresh-button", component: "Button", icon: "refresh", child: "refresh-label", action: { event: { name: "refresh" } } },
  { id: "refresh-label", component: "Text", text: "Refresh" },

  { id: "stats", component: "Grid", columns: 4, children: ["stat-open", "stat-attention", "stat-working", "stat-done"] },
  stat("stat-open", "Open tabs", "open", "focused"),
  stat("stat-attention", "Needs attention", "attention", "failed"),
  stat("stat-working", "Working", "working", "background"),
  stat("stat-done", "Done", "done", "doneShare"),

  { id: "filters", component: "Section", title: "Filters", description: "Narrow the list below, then apply", child: "filters-body" },
  { id: "filters-body", component: "Column", children: ["filter-fields", "filter-statuses", "filter-footer"] },
  { id: "filter-fields", component: "Grid", columns: 2, children: ["filter-query", "filter-sort"] },
  { id: "filter-query", component: "TextField", label: "Search tabs", value: { path: "/query" }, variant: "shortText" },
  {
    id: "filter-sort",
    component: "ChoicePicker",
    label: "Sort by",
    variant: "mutuallyExclusive",
    displayStyle: "dropdown",
    options: SORT_KEYS.map((key) => ({ label: SORT_LABELS[key], value: key })),
    value: { path: "/sort" },
  },
  {
    id: "filter-statuses",
    component: "ChoicePicker",
    label: "Statuses",
    variant: "multipleSelection",
    displayStyle: "chips",
    options: STATUSES.map((status) => ({ label: STATUS_LABELS[status], value: status })),
    value: { path: "/statuses" },
  },
  { id: "filter-footer", component: "Footer", start: ["reset-button"], end: ["apply-button"] },
  { id: "apply-button", component: "Button", variant: "primary", icon: "search", child: "apply-label", action: { event: { name: "applyFilters", context: FILTER_CONTEXT } } },
  { id: "apply-label", component: "Text", text: "Apply filters" },
  { id: "reset-button", component: "Button", variant: "borderless", child: "reset-label", action: { event: { name: "resetFilters" } } },
  { id: "reset-label", component: "Text", text: "Reset" },

  { id: "tabs", component: "Section", title: "Open tabs", description: "Open, reorder or close a tab", child: "tabs-area" },
  { id: "tabs-empty", component: "EmptyState", title: { path: "/empty/title" }, description: { path: "/empty/description" } },
  { id: "tab-list", component: "List", children: { componentId: "tab-row", path: "/rows" } },
  {
    id: "tab-row",
    component: "ListItem",
    title: { path: "title" },
    subtitle: { path: "subtitle" },
    icon: { path: "icon" },
    selected: { path: "active" },
    meta: ["tab-status"],
    primaryAction: "tab-activate",
    actions: ["tab-left", "tab-right", "tab-close"],
  },
  { id: "tab-status", component: "Badge", text: { path: "status" }, variant: { path: "tone" } },
  ...rowButton("tab-activate", "activateTab", "Open"),
  ...rowButton("tab-left", "moveLeft", "Move left", "arrowBack"),
  ...rowButton("tab-right", "moveRight", "Move right", "arrowForward"),
  ...rowButton("tab-close", "closeTab", "Close", "close"),

  { id: "activity", component: "Collapsible", title: "Activity", child: "activity-area", open: true },
  { id: "activity-empty", component: "EmptyState", title: "No changes yet", description: "Changes the workbench reports while this page is open appear here." },
  {
    id: "activity-table",
    component: "Table",
    columns: [
      { key: "time", title: "Time" },
      { key: "event", title: "Change" },
    ],
    rows: { path: "/activity" },
  },
  { id: "raw", component: "Collapsible", title: "Raw tab data", child: "raw-code" },
  { id: "raw-code", component: "Code", text: { path: "/raw" }, language: "json" },
]

export function monitorComponents(hasRows: boolean, hasActivity: boolean): SurfaceComponent[] {
  return [...FIXED, ...tabsArea(hasRows), ...activityArea(hasActivity)]
}

export function monitorData(view: MonitorView, activity: readonly ActivityEntry[]): Record<string, Json> {
  return { statuses: [], query: "", sort: ["index"], ...view, activity: [...activity] }
}

export function openingMessages(surfaceId: string, components: SurfaceComponent[], data: Record<string, Json>): SurfaceMessage[] {
  return [
    { version: "v0.9", createSurface: { surfaceId, catalogId: CATALOG_ID } },
    { version: "v0.9", updateComponents: { surfaceId, components } },
    { version: "v0.9", updateDataModel: { surfaceId, path: "/", value: data } },
  ]
}

export function patch(surfaceId: string, path: string, value?: Json): SurfaceMessage {
  return { version: "v0.9", updateDataModel: value === undefined ? { surfaceId, path } : { surfaceId, path, value } }
}

export function replace(surfaceId: string, components: SurfaceComponent[]): SurfaceMessage {
  return { version: "v0.9", updateComponents: { surfaceId, components } }
}
