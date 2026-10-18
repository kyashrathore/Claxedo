import path from "node:path"
import { writeLivePlugin, type LivePluginFolder } from "./live-plugins"

export const SURFACE_FIXTURE_ID = "surface-fixture"
export const SURFACE_FIXTURE_NAME = "Surface fixture"
export const SURFACE_FIXTURE_PATH = "/surface-fixture"
export const SURFACE_FIXTURE_NO_PROJECT = "No project"

export function surfaceFixtureSource() {
  return `import { definePlugin, type PluginApi, type SurfaceChannel, type SurfaceComponent } from "@claxedo/plugin-api"

const CATALOG = "https://claxedo.dev/a2ui/v0.9/catalog.json"

const itemComponents: SurfaceComponent[] = [
  { id: "root", component: "Column", children: ["title", "search", "items", "add", "projects"] },
  { id: "title", component: "Text", text: "Surface fixture", variant: "h2" },
  { id: "search", component: "TextField", label: "Search items", value: { path: "/query" } },
  { id: "items", component: "List", children: { componentId: "item", path: "/items" } },
  { id: "item", component: "Text", text: { path: "name" } },
  { id: "add", component: "Button", child: "add-label", variant: "primary", action: { event: { name: "addItem", context: { query: { path: "/query" } } } } },
  { id: "add-label", component: "Text", text: "Add item" },
  { id: "projects", component: "List", children: { componentId: "project", path: "/projects" } },
  { id: "project", component: "Button", child: "project-label", action: { event: { name: "openProject", context: { projectId: { path: "id" } } } } },
  { id: "project-label", component: "Text", text: { path: "label" } },
]

const projectComponents: SurfaceComponent[] = [
  { id: "root", component: "Column", children: ["title", "project"] },
  { id: "title", component: "Text", text: "Fixture project", variant: "h2" },
  { id: "project", component: "Text", text: { path: "/project" } },
]

function draw(channel: SurfaceChannel, components: SurfaceComponent[], value: Record<string, unknown>) {
  const { surfaceId } = channel
  channel.send(
    { version: "v0.9", createSurface: { surfaceId, catalogId: CATALOG } },
    { version: "v0.9", updateComponents: { surfaceId, components } },
    { version: "v0.9", updateDataModel: { surfaceId, path: "/", value } },
  )
}

function openItems(api: PluginApi, channel: SurfaceChannel) {
  const items = [{ name: "First item" }]
  const projects = api.projects.list().map((project) => ({ id: project.id, label: "Open " + project.name }))
  draw(channel, itemComponents, { query: "", items, projects })
  return {
    action(action: { name: string; context: Record<string, unknown> }) {
      if (action.name === "openProject" && typeof action.context.projectId === "string") return api.pages.open("project", { projectId: action.context.projectId })
      if (action.name !== "addItem") return
      const query = typeof action.context.query === "string" ? action.context.query.trim() : ""
      const item = { name: query || "Item " + (items.length + 1) }
      items.push(item)
      channel.send({ version: "v0.9", updateDataModel: { surfaceId: channel.surfaceId, path: "/items/" + (items.length - 1), value: item } })
    },
  }
}

function openProject(api: PluginApi, channel: SurfaceChannel) {
  const projectId = api.projects.currentId()
  const project = api.projects.list().find((candidate) => candidate.id === projectId)
  draw(channel, projectComponents, { project: project?.name ?? ${JSON.stringify(SURFACE_FIXTURE_NO_PROJECT)} })
}

export default definePlugin({
  activate(api) {
    api.sidebar.item({ id: "surface", label: ${JSON.stringify(SURFACE_FIXTURE_NAME)}, pageId: "surface" })
    api.pages.register({ id: "surface", path: ${JSON.stringify(SURFACE_FIXTURE_PATH)}, title: ${JSON.stringify(SURFACE_FIXTURE_NAME)}, surface: (channel) => openItems(api, channel) })
    api.pages.register({ id: "project", path: ${JSON.stringify(`${SURFACE_FIXTURE_PATH}/projects/:projectId`)}, title: "Fixture project", surface: (channel) => openProject(api, channel) })
  },
})
`
}

export function surfaceFixtureFolder(): LivePluginFolder {
  return { id: SURFACE_FIXTURE_ID, name: SURFACE_FIXTURE_NAME, app: surfaceFixtureSource() }
}

export async function writeSurfaceFixturePlugin(root: string) {
  return writeLivePlugin(path.join(root, "plugins", SURFACE_FIXTURE_ID), surfaceFixtureFolder())
}
