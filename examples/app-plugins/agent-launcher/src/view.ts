import type { SurfaceComponent, SurfaceMessage } from "@claxedo/plugin-api"
import {
  BATCH_OPTIONS,
  TEMPLATES,
  launchRow,
  launchStats,
  launcherStatus,
  templateById,
  variablesFor,
  type Json,
  type Launch,
  type LaunchStats,
  type LauncherStatus,
  type Project,
} from "./model"

export const CATALOG_ID = "https://claxedo.dev/a2ui/v0.9/catalog.json"

export type LauncherShape = {
  readonly projects: readonly Project[]
  readonly hasLaunches: boolean
  readonly launching: boolean
  readonly hasErrors: boolean
}

const FORM_CONTEXT = {
  template: { path: "/template" },
  project: { path: "/project" },
  prompt: { path: "/prompt" },
  title: { path: "/title" },
  batch: { path: "/batch" },
  variables: { path: "/variables" },
}

export function projectArea(projects: readonly Project[]): SurfaceComponent[] {
  if (projects.length === 0) return [{ id: "project-area", component: "Column", children: ["no-projects"] }]
  return [
    { id: "project-area", component: "Column", children: ["project-picker"] },
    {
      id: "project-picker",
      component: "ChoicePicker",
      label: "Project",
      variant: "mutuallyExclusive",
      displayStyle: "dropdown",
      options: projects.map((project) => ({ label: project.name, value: project.id })),
      value: { path: "/project" },
    },
  ]
}

export function launchArea(launching: boolean, hasErrors: boolean): SurfaceComponent[] {
  const action = launching ? "launch-progress-row" : "launch-footer"
  return [{ id: "launch-area", component: "Column", children: hasErrors ? ["launch-errors", action] : [action] }]
}

export function launchedArea(hasLaunches: boolean): SurfaceComponent[] {
  return [{ id: "launched-area", component: "Column", children: hasLaunches ? ["launched-stats", "launched-list"] : ["launched-empty"] }]
}

function stat(id: string, label: string, key: keyof LaunchStats, caption: string): SurfaceComponent {
  return { id, component: "Stat", label, value: { path: `/stats/${key}` }, caption }
}

const FIXED: readonly SurfaceComponent[] = [
  { id: "root", component: "Column", children: ["header", "template-section", "session-section", "launched-section"] },
  {
    id: "header",
    component: "Header",
    title: "Agent launcher",
    subtitle: "Start one or several agent sessions from a template",
    icon: "send",
    badges: ["header-status"],
  },
  { id: "header-status", component: "Badge", text: { path: "/status/text" }, variant: { path: "/status/tone" } },

  { id: "template-section", component: "Section", title: "Template", description: { path: "/templateNote" }, actions: ["fill-button"], child: "template-body" },
  { id: "template-body", component: "Column", children: ["template-chips", "variables"] },
  { id: "template-chips", component: "List", direction: "horizontal", children: { componentId: "template-chip", path: "/templates" } },
  {
    id: "template-chip",
    component: "Button",
    child: "template-chip-label",
    action: { event: { name: "pickTemplate", context: { id: { path: "id" }, variables: { path: "/variables" } } } },
  },
  { id: "template-chip-label", component: "Text", text: { path: "label" } },
  { id: "variables", component: "Grid", columns: 2, children: { componentId: "variable-field", path: "/variables" } },
  { id: "variable-field", component: "TextField", label: { path: "label" }, value: { path: "value" }, variant: "shortText" },
  {
    id: "fill-button",
    component: "Button",
    variant: "borderless",
    icon: "edit",
    child: "fill-label",
    action: { event: { name: "fillPrompt", context: { template: { path: "/template" }, variables: { path: "/variables" } } } },
  },
  { id: "fill-label", component: "Text", text: "Fill prompt from variables" },

  { id: "session-section", component: "Section", title: "Session", description: "What the agents are told and where they run", child: "session-body" },
  { id: "session-body", component: "Column", children: ["prompt", "session-fields", "launch-area"] },
  { id: "prompt", component: "TextField", label: "Prompt", value: { path: "/prompt" }, variant: "longText" },
  { id: "session-fields", component: "Grid", columns: 3, children: ["project-area", "title", "batch"] },
  { id: "no-projects", component: "EmptyState", title: "No projects", description: "Add a project to Claxedo to launch sessions in it." },
  { id: "title", component: "TextField", label: "Session title", value: { path: "/title" }, variant: "shortText" },
  {
    id: "batch",
    component: "ChoicePicker",
    label: "Parallel sessions",
    variant: "mutuallyExclusive",
    displayStyle: "chips",
    options: BATCH_OPTIONS.map((count) => ({ label: count, value: count })),
    value: { path: "/batch" },
  },
  { id: "launch-errors", component: "Callout", tone: "danger", title: "Can't launch yet", text: { path: "/errors" } },
  { id: "launch-footer", component: "Footer", end: ["launch-button"] },
  { id: "launch-button", component: "Button", variant: "primary", icon: "send", child: "launch-label", action: { event: { name: "launch", context: FORM_CONTEXT } } },
  { id: "launch-label", component: "Text", text: "Launch" },
  { id: "launch-progress-row", component: "Row", align: "center", children: ["launch-spinner", "launch-progress"] },
  { id: "launch-spinner", component: "Spinner", label: { path: "/launching/label" } },
  { id: "launch-progress", component: "Progress", value: { path: "/launching/percent" }, max: 100, label: "Created", weight: 1 },

  {
    id: "launched-section",
    component: "Section",
    title: "Launched sessions",
    description: "Sessions keep running when you leave this page",
    actions: ["clear-button"],
    child: "launched-area",
  },
  { id: "clear-button", component: "Button", variant: "borderless", icon: "delete", child: "clear-label", action: { event: { name: "clearLaunched" } } },
  { id: "clear-label", component: "Text", text: "Clear list" },
  { id: "launched-empty", component: "EmptyState", title: "No sessions launched", description: "Pick a template, write a prompt and press Launch." },
  { id: "launched-stats", component: "Grid", columns: 4, children: ["stat-launched", "stat-active", "stat-attention", "stat-failed"] },
  stat("stat-launched", "Launched", "launched", "In this list"),
  stat("stat-active", "Active", "active", "Running or in background"),
  stat("stat-attention", "Need input", "attention", "Waiting for your reply"),
  stat("stat-failed", "Failed", "failed", "Failed or never started"),
  { id: "launched-list", component: "List", children: { componentId: "launch-row", path: "/launched" } },
  { id: "launch-row", component: "ListItem", title: { path: "title" }, subtitle: { path: "detail" }, icon: "send", meta: ["launch-row-status"], primaryAction: "launch-row-open" },
  { id: "launch-row-status", component: "Badge", text: { path: "status" }, variant: { path: "tone" } },
  { id: "launch-row-open", component: "Button", child: "launch-row-open-label", action: { event: { name: "openSession", context: { key: { path: "key" } } } } },
  { id: "launch-row-open-label", component: "Text", text: "Open" },
]

export function launcherComponents(shape: LauncherShape): SurfaceComponent[] {
  return [...FIXED, ...projectArea(shape.projects), ...launchArea(shape.launching, shape.hasErrors), ...launchedArea(shape.hasLaunches)]
}

export function templateNote(label: string): string {
  return `Selected: ${label}`
}

export function summaryData(launches: readonly Launch[], launching: boolean): { stats: LaunchStats; status: LauncherStatus } {
  return { stats: launchStats(launches), status: launcherStatus(launches, launching) }
}

export function launchedData(launches: readonly Launch[], launching: boolean): Record<string, Json> {
  return { ...summaryData(launches, launching), launched: launches.map(launchRow) }
}

export function launcherData(projects: readonly Project[], currentProjectId: string | undefined, launches: readonly Launch[]): Record<string, Json> {
  const initial = TEMPLATES[0]!
  const project = projects.some((entry) => entry.id === currentProjectId) ? currentProjectId : projects[0]?.id
  return {
    templates: TEMPLATES.map((template) => ({ id: template.id, label: template.label })),
    template: initial.id,
    templateNote: templateNote(initial.label),
    variables: variablesFor(templateById(initial.id), []),
    prompt: initial.body,
    title: "",
    batch: [BATCH_OPTIONS[0]!],
    project: project ? [project] : [],
    errors: "",
    launching: { label: "", percent: 0 },
    ...launchedData(launches, false),
  }
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

export function changedPatches(surfaceId: string, path: string, previous: Readonly<Record<string, Json>>, next: Readonly<Record<string, Json>>): SurfaceMessage[] {
  return Object.keys(next).flatMap((key) => (JSON.stringify(previous[key]) === JSON.stringify(next[key]) ? [] : [patch(surfaceId, `${path}/${key}`, next[key])]))
}

export function replace(surfaceId: string, components: SurfaceComponent[]): SurfaceMessage {
  return { version: "v0.9", updateComponents: { surfaceId, components } }
}
