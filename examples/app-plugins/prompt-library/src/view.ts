import type { SurfaceComponent, SurfaceMessage } from "@claxedo/plugin-api"
import type { PromptTemplate } from "./library"
import type { Json } from "./model"

export const CATALOG_ID = "https://claxedo.dev/a2ui/v0.9/catalog.json"

export type Project = { readonly id: string; readonly name: string }

const SELECTION_CONTEXT = { id: { path: "/selected/id" }, values: { path: "/values" } }

const SEND_CONTEXT = { ...SELECTION_CONTEXT, project: { path: "/project" }, title: { path: "/title" }, openAfter: { path: "/openAfter" } }

const DRAFT_CONTEXT = {
  name: { path: "/draft/name" },
  category: { path: "/draft/category" },
  newCategory: { path: "/draft/newCategory" },
  description: { path: "/draft/description" },
  body: { path: "/draft/body" },
}

type IconName = Extract<SurfaceComponent, { component: "Button" }>["icon"]

type ButtonOptions = { readonly variant?: "default" | "primary" | "borderless"; readonly icon?: IconName }

function button(id: string, label: string | { path: string }, name: string, context: Record<string, { path: string }>, options: ButtonOptions = {}): SurfaceComponent[] {
  return [
    { id, component: "Button", ...options, child: `${id}-label`, action: { event: { name, context } } },
    { id: `${id}-label`, component: "Text", text: label },
  ]
}

export function libraryTabs(categories: readonly string[]): SurfaceComponent[] {
  return [
    {
      id: "library-tabs",
      component: "Tabs",
      tabs: [{ title: { path: "/favouritesTitle" }, child: "fav-panel" }, ...categories.map((_, index) => ({ title: { path: `/tabs/${index}/title` }, child: `category-${index}` }))],
    },
    ...categories.map((_, index): SurfaceComponent => ({ id: `category-${index}`, component: "List", children: { componentId: "template-card", path: `/tabs/${index}/items` } })),
  ]
}

export function draftCategory(categories: readonly string[]): SurfaceComponent[] {
  return [
    {
      id: "draft-category",
      component: "ChoicePicker",
      label: "Category",
      variant: "mutuallyExclusive",
      displayStyle: "dropdown",
      options: categories.map((category) => ({ label: category, value: category })),
      value: { path: "/draft/category" },
    },
  ]
}

export function favouritesPanel(hasFavourites: boolean): SurfaceComponent[] {
  return [{ id: "fav-panel", component: "Column", children: hasFavourites ? ["fav-list"] : ["fav-empty"] }]
}

export function variableForm(template: PromptTemplate | undefined): SurfaceComponent[] {
  const variables = template?.variables ?? []
  if (variables.length === 0) return [{ id: "var-form", component: "Column", children: ["var-none"] }]
  return [
    { id: "var-form", component: "Grid", columns: 2, children: variables.map((_, index) => `var-${index}`) },
    ...variables.map((variable, index): SurfaceComponent => ({
      id: `var-${index}`,
      component: "TextField",
      label: variable.label,
      value: { path: `/values/${variable.name}` },
      variant: "shortText",
    })),
  ]
}

export function detailArea(hasSelection: boolean): SurfaceComponent[] {
  return [{ id: "detail-area", component: "Column", children: hasSelection ? ["detail", "preview-section", "send-section", "code"] : ["detail-empty-section"] }]
}

export function previewStatus(filled: boolean): SurfaceComponent[] {
  return [{ id: "preview-status", component: "Column", children: [filled ? "preview-ready" : "preview-missing"] }]
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

export function sendArea(sending: boolean, hasError: boolean): SurfaceComponent[] {
  const action = sending ? "send-spinner" : "send-footer"
  return [{ id: "send-area", component: "Column", children: hasError ? ["send-error", action] : [action] }]
}

export function draftActions(hasErrors: boolean): SurfaceComponent[] {
  return [{ id: "draft-actions", component: "Column", children: hasErrors ? ["draft-errors", "draft-footer"] : ["draft-footer"] }]
}

const FIXED: SurfaceComponent[] = [
  { id: "root", component: "Column", children: ["header", "library", "detail-area", "create"] },
  { id: "header", component: "Header", title: "Prompt library", subtitle: { path: "/header" }, icon: "star" },

  {
    id: "library",
    component: "Section",
    title: "Templates",
    description: "Use one to fill it in, or star it to keep it under Favourites",
    child: "library-tabs",
  },
  { id: "fav-list", component: "List", children: { componentId: "template-card", path: "/favourites" } },
  { id: "fav-empty", component: "EmptyState", title: "No favourites yet", description: "Star a template to keep it here." },
  {
    id: "template-card",
    component: "ListItem",
    title: { path: "name" },
    subtitle: { path: "summary" },
    meta: ["tc-category", "tc-usage"],
    primaryAction: "tc-use",
    actions: ["tc-favourite"],
  },
  { id: "tc-category", component: "Badge", text: { path: "category" } },
  { id: "tc-usage", component: "Badge", text: { path: "usage" }, variant: { path: "usageTone" } },
  ...button("tc-use", "Use", "selectTemplate", { pick: { path: "id" }, ...SELECTION_CONTEXT }),
  ...button("tc-favourite", { path: "favouriteLabel" }, "toggleFavourite", { template: { path: "id" } }, { icon: { path: "favouriteIcon" } }),

  { id: "detail-empty-section", component: "Section", child: "detail-empty" },
  { id: "detail-empty", component: "EmptyState", title: "No template selected", description: "Press Use on any template to fill it in and send it." },
  { id: "detail", component: "Section", title: { path: "/selected/name" }, description: { path: "/selected/byline" }, child: "detail-body" },
  { id: "detail-body", component: "Column", children: ["detail-description", "variables"] },
  { id: "detail-description", component: "Markdown", text: { path: "/selected/description" } },
  { id: "variables", component: "Section", variant: "plain", title: "Variables", description: "Each one replaces its {placeholder} in the prompt", child: "var-form" },
  { id: "var-none", component: "Text", text: "This template has no variables.", variant: "caption" },

  { id: "preview-section", component: "Section", title: "Preview", description: "The prompt as it will be sent", actions: ["preview-button"], child: "preview-body" },
  ...button("preview-button", "Update preview", "preview", SELECTION_CONTEXT, { icon: "refresh" }),
  { id: "preview-body", component: "Column", children: ["preview", "preview-status"] },
  { id: "preview", component: "Markdown", text: { path: "/preview" } },
  { id: "preview-missing", component: "Callout", tone: "warning", title: "Still to fill", text: { path: "/missing" } },
  { id: "preview-ready", component: "Callout", tone: "success", title: "All variables filled", text: "The prompt is ready to send.", dismissible: true },

  { id: "send-section", component: "Section", title: "Send", description: "Creates a new session with the filled prompt", child: "send-body" },
  { id: "send-body", component: "Column", children: ["send-fields", "open-after", "send-area"] },
  { id: "send-fields", component: "Grid", columns: 2, children: ["project-area", "session-title"] },
  { id: "no-projects", component: "EmptyState", title: "No projects", description: "Add a project to Claxedo to send prompts to it." },
  { id: "session-title", component: "TextField", label: "Session title", value: { path: "/title" }, variant: "shortText" },
  { id: "open-after", component: "CheckBox", label: "Open the session after creating it", value: { path: "/openAfter" } },
  { id: "send-error", component: "Callout", tone: "danger", title: { path: "/sendError/title" }, text: { path: "/sendError/text" } },
  { id: "send-footer", component: "Footer", start: ["code-button"], end: ["send-button"] },
  ...button("send-button", "Send to new session", "send", SEND_CONTEXT, { variant: "primary", icon: "send" }),
  ...button("code-button", "Copy as code", "copyCode", SEND_CONTEXT, { variant: "borderless" }),
  { id: "send-spinner", component: "Spinner", label: "Creating the session" },
  { id: "code", component: "Collapsible", title: "Code", child: "code-block" },
  { id: "code-block", component: "Code", text: { path: "/code" }, language: "ts" },

  { id: "create", component: "Collapsible", title: "Add your own template", child: "create-body" },
  { id: "create-body", component: "Column", children: ["draft-fields", "draft-description", "draft-body", "draft-found", "draft-actions"] },
  { id: "draft-fields", component: "Grid", columns: 3, children: ["draft-name", "draft-category", "draft-new-category"] },
  { id: "draft-name", component: "TextField", label: "Template name", value: { path: "/draft/name" }, variant: "shortText" },
  { id: "draft-new-category", component: "TextField", label: "Or a new category", value: { path: "/draft/newCategory" }, variant: "shortText" },
  { id: "draft-description", component: "TextField", label: "Description (Markdown)", value: { path: "/draft/description" }, variant: "longText" },
  { id: "draft-body", component: "TextField", label: "Prompt body, with {variables} in braces", value: { path: "/draft/body" }, variant: "longText" },
  { id: "draft-found", component: "Row", align: "center", children: ["draft-variables-label", "draft-variables"] },
  { id: "draft-variables-label", component: "Text", text: { path: "/draft/variablesLabel" }, variant: "caption" },
  { id: "draft-variables", component: "List", direction: "horizontal", children: { componentId: "draft-variable", path: "/draft/variables" } },
  { id: "draft-variable", component: "Badge", text: { path: "name" }, variant: "accent" },
  { id: "draft-errors", component: "Callout", tone: "danger", title: "The template needs changes", text: { path: "/draft/errors" } },
  { id: "draft-footer", component: "Footer", start: ["draft-check"], end: ["draft-add"] },
  ...button("draft-check", "Check variables", "checkDraft", DRAFT_CONTEXT, { variant: "borderless" }),
  ...button("draft-add", "Add template", "addTemplate", DRAFT_CONTEXT, { icon: "add" }),
]

export type LibraryShape = {
  readonly categories: readonly string[]
  readonly hasFavourites: boolean
  readonly selected: PromptTemplate | undefined
  readonly previewFilled: boolean
  readonly projects: readonly Project[]
}

export function libraryComponents(shape: LibraryShape): SurfaceComponent[] {
  return [
    ...FIXED,
    ...libraryTabs(shape.categories),
    ...favouritesPanel(shape.hasFavourites),
    ...detailArea(shape.selected !== undefined),
    ...variableForm(shape.selected),
    ...previewStatus(shape.previewFilled),
    ...projectArea(shape.projects),
    ...sendArea(false, false),
    ...draftCategory(shape.categories),
    ...draftActions(false),
  ]
}

export function emptyDraft(category: string): Record<string, Json> {
  return { name: "", category: [category], newCategory: "", description: "", body: "", variables: [], variablesLabel: "Variables found: none yet", errors: "" }
}

export function openingMessages(surfaceId: string, components: SurfaceComponent[], data: Record<string, Json>): SurfaceMessage[] {
  return [
    { version: "v0.9", createSurface: { surfaceId, catalogId: CATALOG_ID } },
    { version: "v0.9", updateComponents: { surfaceId, components } },
    { version: "v0.9", updateDataModel: { surfaceId, path: "/", value: data } },
  ]
}

export function patch(surfaceId: string, path: string, value: Json): SurfaceMessage {
  return { version: "v0.9", updateDataModel: { surfaceId, path, value } }
}

export function replace(surfaceId: string, components: SurfaceComponent[]): SurfaceMessage {
  return { version: "v0.9", updateComponents: { surfaceId, components } }
}
