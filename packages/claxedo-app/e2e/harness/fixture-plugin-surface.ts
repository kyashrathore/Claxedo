import { randomUUID } from "node:crypto"
import path from "node:path"
import { encodeAttachmentData, TASKS_ROUTE_PATH } from "@claxedo/tasks"
import { createTasksClient } from "@claxedo/tasks/client"
import { writeLivePlugin, type LivePluginFolder } from "./live-plugins"

export const SURFACE_FIXTURE_ID = "surface-fixture"
export const SURFACE_FIXTURE_NAME = "Surface fixture"
export const SURFACE_FIXTURE_PATH = "/surface-fixture"
export const SURFACE_FIXTURE_NO_PROJECT = "No project"
export const SURFACE_FIXTURE_SETTINGS = "Fixture surface settings"
export const SURFACE_FIXTURE_ROUTES = [TASKS_ROUTE_PATH]
export const SURFACE_FIXTURE_IMAGE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0x80, 0xc3])

export function surfaceFixtureSource() {
  return `import { definePlugin, type PluginApi, type SurfaceActionEvent, type SurfaceChannel, type SurfaceComponent } from "@claxedo/plugin-api"

const CATALOG = "https://claxedo.dev/a2ui/v0.9/catalog.json"

const button = (id: string, label: string, name: string, context: Record<string, unknown> = {}): SurfaceComponent[] => [
  { id, component: "Button", child: id + "-label", action: { event: { name, context } } } as SurfaceComponent,
  { id: id + "-label", component: "Text", text: label },
]

const itemComponents: SurfaceComponent[] = [
  { id: "root", component: "Column", children: ["title", "selected", "search", "items", "add", "select", "projects", "settings", "fetch-path", "fetch", "fetched"] },
  { id: "title", component: "Text", text: "Surface fixture", variant: "h2" },
  { id: "selected", component: "Text", text: { path: "/selected" } },
  { id: "search", component: "TextField", label: "Search items", value: { path: "/query" } },
  { id: "items", component: "List", children: { componentId: "item", path: "/items" } },
  { id: "item", component: "Text", text: { path: "name" } },
  { id: "add", component: "Button", child: "add-label", variant: "primary", action: { event: { name: "addItem", context: { query: { path: "/query" } } } } },
  { id: "add-label", component: "Text", text: "Add item" },
  ...button("select", "Select the first item", "selectItem"),
  { id: "projects", component: "List", children: { componentId: "project", path: "/projects" } },
  { id: "project", component: "Button", child: "project-label", action: { event: { name: "openProject", context: { projectId: { path: "id" } } } } },
  { id: "project-label", component: "Text", text: { path: "label" } },
  ...button("settings", "Open the fixture settings", "openSettings"),
  { id: "fetch-path", component: "TextField", label: "Fetch path", value: { path: "/fetchPath" } },
  ...button("fetch", "Fetch bytes", "fetchBytes", { path: { path: "/fetchPath" } }),
  { id: "fetched", component: "Text", text: { path: "/fetched" } },
]

const projectComponents: SurfaceComponent[] = [
  { id: "root", component: "Column", children: ["title", "project"] },
  { id: "title", component: "Text", text: "Fixture project", variant: "h2" },
  { id: "project", component: "Text", text: { path: "/project" } },
]

const settingsComponents: SurfaceComponent[] = [
  { id: "root", component: "Column", children: ["title", "configuration", "configured"] },
  { id: "title", component: "Text", text: ${JSON.stringify(`${SURFACE_FIXTURE_SETTINGS} body`)}, variant: "h2" },
  { id: "configuration", component: "AgentConfigurationPicker", placement: "local", value: { path: "/configuration" }, change: { event: { name: "configured" } } },
  { id: "configured", component: "Text", text: { path: "/configured" } },
]

function draw(channel: SurfaceChannel, components: SurfaceComponent[], value: Record<string, unknown>) {
  const { surfaceId } = channel
  channel.send(
    { version: "v0.9", createSurface: { surfaceId, catalogId: CATALOG } },
    { version: "v0.9", updateComponents: { surfaceId, components } },
    { version: "v0.9", updateDataModel: { surfaceId, path: "/", value } },
  )
}

function patch(channel: SurfaceChannel, path: string, value: unknown) {
  channel.send({ version: "v0.9", updateDataModel: { surfaceId: channel.surfaceId, path, value } })
}

async function fetchedBytes(api: PluginApi, path: string) {
  const response = await api.server.fetch(path)
  const bytes = new Uint8Array(await response.arrayBuffer())
  return response.status + " " + response.headers.get("content-type") + " " + Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(" ")
}

function openItems(api: PluginApi, channel: SurfaceChannel, itemId: string | undefined) {
  const items = [{ name: "First item" }]
  const projects = api.projects.list().map((project) => ({ id: project.id, label: "Open " + project.name }))
  draw(channel, itemComponents, { query: "", items, projects, selected: "Selected: " + (itemId ?? "none"), fetchPath: "", fetched: "" })
  const act: Record<string, (action: SurfaceActionEvent) => unknown> = {
    openProject: (action) => typeof action.context.projectId === "string" && api.pages.open("project", { projectId: action.context.projectId }),
    selectItem: () => api.pages.open("surface", { itemId: "first" }),
    openSettings: () => api.settings.open("settings"),
    fetchBytes: async (action) => patch(channel, "/fetched", await fetchedBytes(api, String(action.context.path))),
    addItem: (action) => {
      const query = typeof action.context.query === "string" ? action.context.query.trim() : ""
      items.push({ name: query || "Item " + (items.length + 1) })
      patch(channel, "/items/" + (items.length - 1), items[items.length - 1])
    },
  }
  return {
    action: async (action: SurfaceActionEvent) => {
      await act[action.name]?.(action)
    },
    navigated: (props: { params: Readonly<Record<string, string>> }) => patch(channel, "/selected", "Selected: " + (props.params.itemId ?? "none")),
  }
}

function openSettings(channel: SurfaceChannel) {
  draw(channel, settingsComponents, { configuration: { harness: null, model: null, effort: null }, configured: "Harness: none" })
  return {
    action: (action: SurfaceActionEvent) => {
      const value = action.context.value as { harness: { id: string } | null } | undefined
      if (action.name === "configured") patch(channel, "/configured", "Harness: " + (value?.harness?.id ?? "none"))
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
    api.pages.register({
      id: "surface",
      path: ${JSON.stringify(`${SURFACE_FIXTURE_PATH}/:itemId?`)},
      title: ${JSON.stringify(SURFACE_FIXTURE_NAME)},
      tab: true,
      icon: "checklist",
      surface: (channel, props) => openItems(api, channel, props.params.itemId),
    })
    api.pages.register({ id: "project", path: ${JSON.stringify(`${SURFACE_FIXTURE_PATH}/projects/:projectId`)}, title: "Fixture project", surface: (channel) => openProject(api, channel) })
    api.settings.section({ id: "settings", title: ${JSON.stringify(SURFACE_FIXTURE_SETTINGS)}, surface: (channel) => openSettings(channel) })
  },
})
`
}

export function surfaceFixtureFolder(): LivePluginFolder {
  return { id: SURFACE_FIXTURE_ID, name: SURFACE_FIXTURE_NAME, routes: SURFACE_FIXTURE_ROUTES, app: surfaceFixtureSource() }
}

export async function writeSurfaceFixturePlugin(root: string) {
  return writeLivePlugin(path.join(root, "plugins", SURFACE_FIXTURE_ID), surfaceFixtureFolder())
}

export async function storeSurfaceFixtureImage(serverUrl: string, projectId: string) {
  const client = createTasksClient({ baseUrl: new URL(TASKS_ROUTE_PATH, serverUrl).href, request: (url, init) => fetch(url, init) })
  const data = encodeAttachmentData(SURFACE_FIXTURE_IMAGE)
  const input = { projectId, title: "Fixture image", description: "", workspaceId: null, parentTaskId: null, attachments: [{ filename: "fixture.png", mime: "image/png" as const, data }] }
  const created = await client.command({ clientRequestId: randomUUID(), command: { type: "task.create", input } })
  if (created.result.type !== "task.create") throw new Error(`task.create answered ${created.result.type}`)
  const taskId = created.result.task.id
  const read = async () => (await client.getTask(taskId)).attachments
  const [attachment] = await read()
  if (!attachment) throw new Error("the fixture task stored no attachment")
  return { path: `${TASKS_ROUTE_PATH}/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachment.id)}`, read }
}
