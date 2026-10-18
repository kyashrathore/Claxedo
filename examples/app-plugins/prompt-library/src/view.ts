import type { SurfaceComponent, SurfaceMessage } from "@claxedo/plugin-api"
import type { PromptTemplate } from "./library"
import type { Json } from "./model"

export const CATALOG_ID = "https://claxedo.dev/a2ui/v0.9/catalog.json"

export type Project = { readonly id: string; readonly name: string }

export type LibraryShape = {
  readonly categories: readonly string[]
  readonly hasFavourites: boolean
  readonly selected: PromptTemplate | undefined
  readonly projects: readonly Project[]
  readonly sending: boolean
}

const FAVOURITES_CONTEXT = { tabs: { path: "/tabs" }, favourites: { path: "/favourites" } }

const SELECTION_CONTEXT = { id: { path: "/selected/id" }, values: { path: "/values" } }

const SEND_CONTEXT = { ...SELECTION_CONTEXT, project: { path: "/project" }, title: { path: "/title" }, openAfter: { path: "/openAfter" } }

const DRAFT_CONTEXT = {
  name: { path: "/draft/name" },
  category: { path: "/draft/category" },
  newCategory: { path: "/draft/newCategory" },
  description: { path: "/draft/description" },
  body: { path: "/draft/body" },
}

function button(id: string, label: string, name: string, context: Record<string, { path: string }>, variant: "default" | "primary" | "borderless" = "default"): SurfaceComponent[] {
  return [
    { id, component: "Button", variant, child: `${id}-label`, action: { event: { name, context } } },
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
    { id: "var-form", component: "Column", children: variables.map((_, index) => `var-${index}`) },
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
  return [{ id: "detail-area", component: "Column", children: hasSelection ? ["detail-card"] : ["detail-empty"] }]
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

export function sendArea(sending: boolean): SurfaceComponent[] {
  return [{ id: "send-area", component: "Row", align: "center", children: sending ? ["send-spinner"] : ["send-button", "code-button"] }]
}

const FIXED: SurfaceComponent[] = [
  { id: "root", component: "Column", children: ["header", "library-card", "detail-area", "create"] },
  { id: "header", component: "Row", align: "center", children: ["header-icon", "header-text"] },
  { id: "header-icon", component: "Icon", name: "star" },
  { id: "header-text", component: "Column", children: ["header-title", "header-summary"], weight: 1 },
  { id: "header-title", component: "Text", text: "Prompt library", variant: "h2" },
  { id: "header-summary", component: "Text", text: { path: "/header" }, variant: "caption" },

  { id: "library-card", component: "Card", child: "library" },
  { id: "library", component: "Column", children: ["library-tabs", "library-footer"] },
  { id: "fav-list", component: "List", children: { componentId: "template-card", path: "/favourites" } },
  { id: "fav-empty", component: "EmptyState", title: "No favourites yet", description: "Turn on Favourite for a template, then press Save favourites." },
  { id: "template-card", component: "Card", child: "tc-body" },
  { id: "tc-body", component: "Column", children: ["tc-top", "tc-summary", "tc-actions"] },
  { id: "tc-top", component: "Row", align: "center", children: ["tc-name", "tc-category", "tc-usage"] },
  { id: "tc-name", component: "Text", text: { path: "name" }, variant: "h4", weight: 1 },
  { id: "tc-category", component: "Badge", text: { path: "category" }, variant: "neutral" },
  { id: "tc-usage", component: "Badge", text: { path: "usage" }, variant: "accent" },
  { id: "tc-summary", component: "Text", text: { path: "summary" }, variant: "caption" },
  { id: "tc-actions", component: "Row", align: "center", justify: "spaceBetween", children: ["tc-favourite", "tc-use"] },
  { id: "tc-favourite", component: "Switch", label: "Favourite", value: { path: "favourite" } },
  { id: "tc-use", component: "Button", variant: "primary", child: "tc-use-label", action: { event: { name: "selectTemplate", context: { pick: { path: "id" }, ...SELECTION_CONTEXT, ...FAVOURITES_CONTEXT } } } },
  { id: "tc-use-label", component: "Text", text: "Use template" },
  { id: "library-footer", component: "Row", align: "center", justify: "spaceBetween", children: ["library-hint", "save-favourites"] },
  { id: "library-hint", component: "Text", text: "Favourite switches are saved when you press Save favourites or use a template.", variant: "caption" },
  ...button("save-favourites", "Save favourites", "saveFavourites", FAVOURITES_CONTEXT),

  { id: "detail-empty", component: "EmptyState", title: "No template selected", description: "Press Use template on any card to fill it in and send it." },
  { id: "detail-card", component: "Card", child: "detail" },
  {
    id: "detail",
    component: "Column",
    children: ["detail-top", "detail-description", "detail-divider", "vars-title", "var-form", "preview-row", "preview", "send-title", "project-area", "session-title", "open-after", "send-area", "code"],
  },
  { id: "detail-top", component: "Row", align: "center", children: ["detail-name", "detail-category", "detail-variables", "detail-usage"] },
  { id: "detail-name", component: "Text", text: { path: "/selected/name" }, variant: "h3", weight: 1 },
  { id: "detail-category", component: "Badge", text: { path: "/selected/category" }, variant: "neutral" },
  { id: "detail-variables", component: "Badge", text: { path: "/selected/variables" }, variant: "neutral" },
  { id: "detail-usage", component: "Badge", text: { path: "/selected/usage" }, variant: "accent" },
  { id: "detail-description", component: "Markdown", text: { path: "/selected/description" } },
  { id: "detail-divider", component: "Divider" },
  { id: "vars-title", component: "Text", text: "Variables", variant: "h4" },
  { id: "var-none", component: "Text", text: "This template has no variables.", variant: "caption" },
  { id: "preview-row", component: "Row", align: "center", children: ["preview-title", "preview-button"] },
  { id: "preview-title", component: "Text", text: "Preview", variant: "h4", weight: 1 },
  ...button("preview-button", "Update preview", "preview", SELECTION_CONTEXT),
  { id: "preview", component: "Markdown", text: { path: "/preview" } },
  { id: "send-title", component: "Text", text: "Send", variant: "h4" },
  { id: "no-projects", component: "EmptyState", title: "No projects", description: "Add a project to Claxedo to send prompts to it." },
  { id: "session-title", component: "TextField", label: "Session title", value: { path: "/title" }, variant: "shortText" },
  { id: "open-after", component: "CheckBox", label: "Open the session after creating it", value: { path: "/openAfter" } },
  ...button("send-button", "Send to new session", "send", SEND_CONTEXT, "primary"),
  ...button("code-button", "Copy as code", "copyCode", SEND_CONTEXT, "borderless"),
  { id: "send-spinner", component: "Spinner", label: "Creating the session" },
  { id: "code", component: "Collapsible", title: "Code", child: "code-block", open: true },
  { id: "code-block", component: "Code", text: { path: "/code" }, language: "ts" },

  { id: "create", component: "Collapsible", title: "Add your own template", child: "create-body" },
  {
    id: "create-body",
    component: "Column",
    children: ["draft-name", "draft-category-row", "draft-description", "draft-body", "draft-actions", "draft-variables-label", "draft-variables", "draft-errors"],
  },
  { id: "draft-name", component: "TextField", label: "Template name", value: { path: "/draft/name" }, variant: "shortText" },
  { id: "draft-category-row", component: "Row", align: "end", children: ["draft-category", "draft-new-category"] },
  { id: "draft-new-category", component: "TextField", label: "Or a new category", value: { path: "/draft/newCategory" }, variant: "shortText", weight: 1 },
  { id: "draft-description", component: "TextField", label: "Description (Markdown)", value: { path: "/draft/description" }, variant: "longText" },
  { id: "draft-body", component: "TextField", label: "Prompt body, with {variables} in braces", value: { path: "/draft/body" }, variant: "longText" },
  { id: "draft-actions", component: "Row", children: ["draft-check", "draft-add"] },
  ...button("draft-check", "Check variables", "checkDraft", DRAFT_CONTEXT),
  ...button("draft-add", "Add template", "addTemplate", DRAFT_CONTEXT, "primary"),
  { id: "draft-variables-label", component: "Text", text: { path: "/draft/variablesLabel" }, variant: "caption" },
  { id: "draft-variables", component: "List", direction: "horizontal", children: { componentId: "draft-variable", path: "/draft/variables" } },
  { id: "draft-variable", component: "Badge", text: { path: "name" }, variant: "accent" },
  { id: "draft-errors", component: "Markdown", text: { path: "/draft/errors" } },
]

export function libraryComponents(shape: LibraryShape): SurfaceComponent[] {
  return [
    ...FIXED,
    ...libraryTabs(shape.categories),
    ...favouritesPanel(shape.hasFavourites),
    ...detailArea(shape.selected !== undefined),
    ...variableForm(shape.selected),
    ...projectArea(shape.projects),
    ...sendArea(shape.sending),
    ...draftCategory(shape.categories),
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
