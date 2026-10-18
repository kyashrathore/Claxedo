import type { SurfaceComponent, SurfaceMessage } from "@claxedo/plugin-api"
import {
  MAX_BATCH,
  TEMPLATES,
  launchRow,
  statusSummary,
  summaryLine,
  templateById,
  variablesFor,
  type Json,
  type Launch,
  type Project,
} from "./model"

export const CATALOG_ID = "https://claxedo.dev/a2ui/v0.9/catalog.json"

export type LauncherShape = {
  readonly projects: readonly Project[]
  readonly hasLaunches: boolean
  readonly launching: boolean
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

export function launchArea(launching: boolean): SurfaceComponent[] {
  return [{ id: "launch-area", component: "Row", align: "center", children: launching ? ["launch-spinner", "launch-progress"] : ["launch-button"] }]
}

export function launchedArea(hasLaunches: boolean): SurfaceComponent[] {
  return [{ id: "launched-area", component: "Column", children: hasLaunches ? ["counts-table", "launched-list"] : ["launched-empty"] }]
}

const FIXED: readonly SurfaceComponent[] = [
  { id: "root", component: "Column", children: ["header", "form-card", "launched-card"] },
  { id: "header", component: "Row", align: "center", children: ["header-icon", "header-text"] },
  { id: "header-icon", component: "Icon", name: "send" },
  { id: "header-text", component: "Column", children: ["header-title", "header-subtitle"], weight: 1 },
  { id: "header-title", component: "Text", text: "Agent launcher", variant: "h2" },
  { id: "header-subtitle", component: "Text", text: "Start one or several agent sessions from a template.", variant: "caption" },

  { id: "form-card", component: "Card", child: "form" },
  {
    id: "form",
    component: "Column",
    children: ["project-area", "template-heading", "template-chips", "template-selected", "variables", "fill-button", "prompt", "title", "batch", "errors", "form-divider", "launch-area"],
  },
  { id: "no-projects", component: "EmptyState", title: "No projects", description: "Add a project to Claxedo to launch sessions in it." },
  { id: "template-heading", component: "Text", text: "Template", variant: "h4" },
  { id: "template-chips", component: "List", direction: "horizontal", children: { componentId: "template-chip", path: "/templates" } },
  {
    id: "template-chip",
    component: "Button",
    variant: "default",
    child: "template-chip-label",
    action: { event: { name: "pickTemplate", context: { id: { path: "id" }, variables: { path: "/variables" } } } },
  },
  { id: "template-chip-label", component: "Text", text: { path: "label" } },
  { id: "template-selected", component: "Row", align: "center", children: ["template-selected-label", "template-selected-badge"] },
  { id: "template-selected-label", component: "Text", text: "Selected template", variant: "caption" },
  { id: "template-selected-badge", component: "Badge", text: { path: "/templateLabel" }, variant: "accent" },
  { id: "variables", component: "List", children: { componentId: "variable-field", path: "/variables" } },
  { id: "variable-field", component: "TextField", label: { path: "label" }, value: { path: "value" }, variant: "shortText" },
  {
    id: "fill-button",
    component: "Button",
    variant: "borderless",
    child: "fill-label",
    action: { event: { name: "fillPrompt", context: { template: { path: "/template" }, variables: { path: "/variables" } } } },
  },
  { id: "fill-label", component: "Text", text: "Fill prompt from variables" },
  { id: "prompt", component: "TextField", label: "Prompt", value: { path: "/prompt" }, variant: "longText" },
  { id: "title", component: "TextField", label: "Session title", value: { path: "/title" }, variant: "shortText" },
  { id: "batch", component: "Slider", label: "Parallel sessions", min: 1, max: MAX_BATCH, step: 1, value: { path: "/batch" } },
  { id: "errors", component: "Markdown", text: { path: "/errors" } },
  { id: "form-divider", component: "Divider" },
  { id: "launch-button", component: "Button", variant: "primary", child: "launch-label", action: { event: { name: "launch", context: FORM_CONTEXT } } },
  { id: "launch-label", component: "Text", text: "Launch" },
  { id: "launch-spinner", component: "Spinner", label: { path: "/launching/label" } },
  { id: "launch-progress", component: "Progress", value: { path: "/launching/percent" }, max: 100, label: "Created", weight: 1 },

  { id: "launched-card", component: "Card", child: "launched" },
  { id: "launched", component: "Column", children: ["launched-header", "launched-area"] },
  { id: "launched-header", component: "Row", align: "center", children: ["launched-title", "launched-summary", "clear-button"] },
  { id: "launched-title", component: "Text", text: "Launched", variant: "h3" },
  { id: "launched-summary", component: "Badge", text: { path: "/summary" }, variant: "neutral", weight: 1 },
  { id: "clear-button", component: "Button", variant: "borderless", child: "clear-label", action: { event: { name: "clearLaunched" } } },
  { id: "clear-label", component: "Text", text: "Clear list" },
  { id: "launched-empty", component: "EmptyState", title: "No sessions launched", description: "Pick a template, write a prompt and press Launch." },
  {
    id: "counts-table",
    component: "Table",
    columns: [
      { key: "status", title: "Status" },
      { key: "count", title: "Sessions" },
    ],
    rows: { path: "/counts" },
  },
  { id: "launched-list", component: "List", children: { componentId: "launch-row", path: "/launched" } },
  { id: "launch-row", component: "Card", child: "launch-row-body" },
  { id: "launch-row-body", component: "Column", children: ["launch-row-top", "launch-row-detail", "launch-row-actions"] },
  { id: "launch-row-top", component: "Row", align: "center", children: ["launch-row-title", "launch-row-status"] },
  { id: "launch-row-title", component: "Text", text: { path: "title" }, variant: "h5", weight: 1 },
  { id: "launch-row-status", component: "Badge", text: { path: "status" }, variant: "accent" },
  { id: "launch-row-detail", component: "Text", text: { path: "detail" }, variant: "caption" },
  { id: "launch-row-actions", component: "Row", justify: "end", children: ["launch-row-open"] },
  { id: "launch-row-open", component: "Button", variant: "default", child: "launch-row-open-label", action: { event: { name: "openSession", context: { key: { path: "key" } } } } },
  { id: "launch-row-open-label", component: "Text", text: "Open" },
]

export function launcherComponents(shape: LauncherShape): SurfaceComponent[] {
  return [...FIXED, ...projectArea(shape.projects), ...launchArea(shape.launching), ...launchedArea(shape.hasLaunches)]
}

export function launchedData(launches: readonly Launch[]): Record<string, Json> {
  return {
    summary: summaryLine(launches),
    counts: statusSummary(launches),
    launched: launches.map(launchRow),
  }
}

export function launcherData(projects: readonly Project[], currentProjectId: string | undefined, launches: readonly Launch[]): Record<string, Json> {
  const initial = TEMPLATES[0]!
  const project = projects.some((entry) => entry.id === currentProjectId) ? currentProjectId : projects[0]?.id
  return {
    templates: TEMPLATES.map((template) => ({ id: template.id, label: template.label })),
    template: initial.id,
    templateLabel: initial.label,
    variables: variablesFor(templateById(initial.id), []),
    prompt: initial.body,
    title: "",
    batch: 1,
    project: project ? [project] : [],
    errors: "",
    launching: { label: "", percent: 0 },
    ...launchedData(launches),
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

export function replace(surfaceId: string, components: SurfaceComponent[]): SurfaceMessage {
  return { version: "v0.9", updateComponents: { surfaceId, components } }
}
