import type { SurfaceComponent, SurfaceMessage } from "@claxedo/plugin-api"
import { SORT_KEYS, SORT_LABELS, STATUSES, STATUS_LABELS, type ActivityEntry, type Json, type MonitorView } from "./model"

export const CATALOG_ID = "https://claxedo.dev/a2ui/v0.9/catalog.json"

const FILTER_CONTEXT = { statuses: { path: "/statuses" }, query: { path: "/query" }, sort: { path: "/sort" } }

function rowButton(id: string, name: string, label: string): SurfaceComponent[] {
  return [
    { id, component: "Button", variant: name === "activateTab" ? "default" : "borderless", child: `${id}-label`, action: { event: { name, context: { id: { path: "id" } } } } },
    { id: `${id}-label`, component: "Text", text: label },
  ]
}

const COUNT_BADGES: SurfaceComponent[] = STATUSES.map((status) => ({
  id: `count-${status}`,
  component: "Badge",
  text: { path: `/counts/${status}` },
  variant: status === "attention" || status === "failed" ? "accent" : "neutral",
}))

export function tabsArea(hasRows: boolean): SurfaceComponent[] {
  return [{ id: "tabs-area", component: "Column", children: hasRows ? ["tab-list"] : ["tabs-empty"] }]
}

const FIXED: SurfaceComponent[] = [
  { id: "root", component: "Column", children: ["header", "summary-card", "filters-card", "tabs-card", "activity", "raw"] },
  { id: "header", component: "Row", align: "center", children: ["header-icon", "header-text", "refresh-button"] },
  { id: "header-icon", component: "Icon", name: "visibility" },
  { id: "header-text", component: "Column", children: ["header-title", "header-summary"], weight: 1 },
  { id: "header-title", component: "Text", text: "Workbench monitor", variant: "h2" },
  { id: "header-summary", component: "Text", text: { path: "/summary" }, variant: "caption" },
  { id: "refresh-button", component: "Button", variant: "borderless", child: "refresh-label", action: { event: { name: "refresh" } } },
  { id: "refresh-label", component: "Text", text: "Refresh" },

  { id: "summary-card", component: "Card", child: "summary" },
  { id: "summary", component: "Column", children: ["counts-row", "done-progress"] },
  { id: "counts-row", component: "Row", children: COUNT_BADGES.map((badge) => badge.id) },
  ...COUNT_BADGES,
  { id: "done-progress", component: "Progress", value: { path: "/done/percent" }, max: 100, label: { path: "/done/label" } },

  { id: "filters-card", component: "Card", child: "filters" },
  { id: "filters", component: "Column", children: ["filter-statuses", "filter-row", "filter-actions"] },
  {
    id: "filter-statuses",
    component: "ChoicePicker",
    label: "Statuses",
    variant: "multipleSelection",
    displayStyle: "chips",
    options: STATUSES.map((status) => ({ label: STATUS_LABELS[status], value: status })),
    value: { path: "/statuses" },
  },
  { id: "filter-row", component: "Row", align: "end", children: ["filter-query", "filter-sort"] },
  { id: "filter-query", component: "TextField", label: "Search tabs", value: { path: "/query" }, variant: "shortText", weight: 1 },
  {
    id: "filter-sort",
    component: "ChoicePicker",
    label: "Sort by",
    variant: "mutuallyExclusive",
    displayStyle: "dropdown",
    options: SORT_KEYS.map((key) => ({ label: SORT_LABELS[key], value: key })),
    value: { path: "/sort" },
  },
  { id: "filter-actions", component: "Row", children: ["apply-button", "reset-button"] },
  { id: "apply-button", component: "Button", variant: "primary", child: "apply-label", action: { event: { name: "applyFilters", context: FILTER_CONTEXT } } },
  { id: "apply-label", component: "Text", text: "Apply filters" },
  { id: "reset-button", component: "Button", variant: "borderless", child: "reset-label", action: { event: { name: "resetFilters" } } },
  { id: "reset-label", component: "Text", text: "Reset" },

  { id: "tabs-card", component: "Card", child: "tabs" },
  { id: "tabs", component: "Column", children: ["tabs-title", "tabs-area"] },
  { id: "tabs-title", component: "Text", text: "Open tabs", variant: "h3" },
  { id: "tabs-empty", component: "EmptyState", title: { path: "/empty/title" }, description: { path: "/empty/description" } },
  { id: "tab-list", component: "List", children: { componentId: "tab-row", path: "/rows" } },
  { id: "tab-row", component: "Card", child: "tab-row-body" },
  { id: "tab-row-body", component: "Row", align: "center", children: ["tab-position", "tab-main", "tab-status", "tab-actions"] },
  { id: "tab-position", component: "Text", text: { path: "position" }, variant: "caption" },
  { id: "tab-main", component: "Column", children: ["tab-title", "tab-meta"], weight: 1 },
  { id: "tab-title", component: "Text", text: { path: "title" }, variant: "h5" },
  { id: "tab-meta", component: "Row", children: ["tab-kind", "tab-marker"] },
  { id: "tab-kind", component: "Text", text: { path: "meta" }, variant: "caption" },
  { id: "tab-marker", component: "Text", text: { path: "marker" }, variant: "caption" },
  { id: "tab-status", component: "Badge", text: { path: "status" }, variant: "accent" },
  { id: "tab-actions", component: "Row", children: ["tab-activate", "tab-left", "tab-right", "tab-close"] },
  ...rowButton("tab-activate", "activateTab", "Activate"),
  ...rowButton("tab-left", "moveLeft", "Move left"),
  ...rowButton("tab-right", "moveRight", "Move right"),
  ...rowButton("tab-close", "closeTab", "Close"),

  { id: "activity", component: "Collapsible", title: "Activity", child: "activity-body", open: true },
  { id: "activity-body", component: "Column", children: ["activity-hint", "activity-table"] },
  { id: "activity-hint", component: "Text", text: "Changes the workbench reported while this page was open.", variant: "caption" },
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

export function monitorComponents(hasRows: boolean): SurfaceComponent[] {
  return [...FIXED, ...tabsArea(hasRows)]
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
