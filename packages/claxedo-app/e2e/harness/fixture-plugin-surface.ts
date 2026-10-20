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
export const SURFACE_FIXTURE_PICTURE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGNQTX5NEmIY1TCqYfhqAAB2SXMQ7mVTQgAAAABJRU5ErkJggg=="
export const SURFACE_FIXTURE_REMOTE_PICTURE = "https://images.invalid/fixture.png"

const pageComponents = `const button = (id: string, label: string, name: string, context: Record<string, unknown> = {}): SurfaceComponent[] => [
  { id, component: "Button", child: id + "-label", action: { event: { name, context } } } as SurfaceComponent,
  { id: id + "-label", component: "Text", text: label },
]

const itemComponents: SurfaceComponent[] = [
  {
    id: "root",
    component: "Column",
    children: ["title", "selected", "search", "items", "add", "select", "project-links", "settings", "fetch-path", "fetch", "fetched", "pictures", "order", "order-note", "board", "move-note", "attachments", "project", "project-note"],
  },
  { id: "title", component: "Text", text: "Surface fixture", variant: "h2" },
  { id: "selected", component: "Text", text: { path: "/selected" } },
  { id: "search", component: "TextField", label: "Search items", value: { path: "/query" } },
  { id: "items", component: "List", children: { componentId: "item", path: "/items" } },
  { id: "item", component: "Text", text: { path: "name" } },
  { id: "add", component: "Button", child: "add-label", variant: "primary", action: { event: { name: "addItem", context: { query: { path: "/query" } } } } },
  { id: "add-label", component: "Text", text: "Add item" },
  ...button("select", "Select the first item", "selectItem"),
  { id: "project-links", component: "List", children: { componentId: "project-link", path: "/projectLinks" } },
  { id: "project-link", component: "Button", child: "project-link-label", action: { event: { name: "openProjectPage", context: { projectId: { path: "id" } } } } },
  { id: "project-link-label", component: "Text", text: { path: "label" } },
  ...button("settings", "Open the fixture settings", "openSettings"),
  { id: "fetch-path", component: "TextField", label: "Fetch path", value: { path: "/fetchPath" } },
  ...button("fetch", "Fetch bytes", "fetchBytes", { path: { path: "/fetchPath" } }),
  { id: "fetched", component: "Text", text: { path: "/fetched" } },
  { id: "pictures", component: "Row", children: ["picture", "remote-picture"] },
  { id: "picture", component: "Image", url: { path: "/picture" }, variant: "avatar", accessibility: { label: "Fixture swatch" } },
  { id: "remote-picture", component: "Image", url: ${JSON.stringify(SURFACE_FIXTURE_REMOTE_PICTURE)}, variant: "mediumFeature", accessibility: { label: "Remote picture" } },
  {
    id: "order",
    component: "ChoicePicker",
    label: "Order",
    displayStyle: "chips",
    options: [{ label: "Oldest", value: "oldest" }, { label: "Newest", value: "newest" }],
    value: { path: "/order" },
    change: { event: { name: "orderItems" } },
  },
  { id: "order-note", component: "Text", text: { path: "/orderNote" } },
  {
    id: "board",
    component: "Board",
    columns: [{ key: "todo", title: "To do", items: "/todo" }, { key: "done", title: "Done", items: "/done" }],
    item: "card",
    itemKey: "id",
    move: { event: { name: "moveCard" } },
  },
  { id: "card", component: "ListItem", title: { path: "title" } },
  { id: "move-note", component: "Text", text: { path: "/moveNote" } },
  { id: "attachments", component: "Section", title: "Attachments", child: "attachments-body" },
  { id: "attachments-body", component: "Column", children: ["attach", "attached", "attach-note"] },
  { id: "attach", component: "FilePicker", label: "Attach images", accept: ["image/png", "image/jpeg"], maxBytes: 4096, maxFiles: 3, paste: "section", pick: { event: { name: "attachImages" } } },
  { id: "attached", component: "Grid", columns: 4, children: { componentId: "attached-image", path: "/attached" } },
  { id: "attached-image", component: "Image", url: { path: "url" }, variant: "smallFeature", accessibility: { label: { path: "name" } } },
  { id: "attach-note", component: "Text", text: { path: "/attachNote" } },
  {
    id: "project",
    component: "Combobox",
    label: "Project",
    value: { path: "/project" },
    options: { path: "/projects" },
    query: { path: "/projectQuery" },
    search: { event: { name: "findProjects" } },
    change: { event: { name: "chooseProject" } },
    placeholder: "Search projects",
  },
  { id: "project-note", component: "Text", text: { path: "/projectNote" } },
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
]`

const pageRules = `const PROJECTS = [
  { label: "Claxedo app", value: "app", description: "The desktop and web app" },
  { label: "Docs site", value: "docs", description: "Guides and reference" },
  { label: "Relay", value: "relay", description: "Workspace relay" },
]

function attached(files: unknown) {
  return (Array.isArray(files) ? files : []).map((file) => ({ name: String(file.name), url: "data:" + file.mimeType + ";base64," + file.dataBase64 }))
}

function refusals(refused: unknown) {
  const list = Array.isArray(refused) ? refused : []
  return list.length === 0 ? "Nothing refused" : list.map((file) => "Refused " + file.name + ": " + file.reason).join("; ")
}

function moveCard(lanes: Record<string, { id: string; title: string }[]>, context: Record<string, unknown>) {
  const from = lanes[String(context.fromColumn)]
  const to = lanes[String(context.toColumn)]
  const index = from ? from.findIndex((card) => card.id === context.itemId) : -1
  if (!from || !to || index === -1) return undefined
  const [card] = from.splice(index, 1)
  to.splice(Number(context.toIndex), 0, card)
  return card.title + " is in " + String(context.toColumn) + " at " + (Number(context.toIndex) + 1)
}

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
}`

const pagePrograms = `function itemModel(api: PluginApi, itemId: string | undefined, lanes: Record<string, unknown>) {
  const projectLinks = api.projects.list().map((project) => ({ id: project.id, label: "Open " + project.name }))
  return {
    query: "", items: [{ name: "First item" }], projectLinks, selected: "Selected: " + (itemId ?? "none"), fetchPath: "", fetched: "",
    picture: ${JSON.stringify(SURFACE_FIXTURE_PICTURE)}, order: ["oldest"], orderNote: "Ordered oldest first", ...lanes, moveNote: "No card moved yet",
    attached: [], attachNote: "No images yet", project: "", projectQuery: "", projects: PROJECTS, projectNote: "No project chosen",
  }
}

function openItems(api: PluginApi, channel: SurfaceChannel, itemId: string | undefined) {
  const lanes = { todo: [{ id: "c1", title: "First card" }, { id: "c2", title: "Second card" }], done: [{ id: "c3", title: "Third card" }] }
  const model = itemModel(api, itemId, lanes)
  const items = model.items
  draw(channel, itemComponents, model)
  const act: Record<string, (action: SurfaceActionEvent) => unknown> = {
    openProjectPage: (action) => typeof action.context.projectId === "string" && api.pages.open("project", { projectId: action.context.projectId }),
    selectItem: () => api.pages.open("surface", { itemId: "first" }),
    openSettings: () => api.settings.open("settings"),
    fetchBytes: async (action) => patch(channel, "/fetched", await fetchedBytes(api, String(action.context.path))),
    attachImages: (action) => {
      patch(channel, "/attached", attached(action.context.files))
      patch(channel, "/attachNote", refusals(action.context.refused))
    },
    findProjects: (action) => patch(channel, "/projects", PROJECTS.filter((project) => project.label.toLowerCase().includes(String(action.context.query).toLowerCase()))),
    chooseProject: (action) => patch(channel, "/projectNote", "Chose " + String(action.context.value)),
    moveCard: (action) => {
      const note = moveCard(lanes, action.context)
      patch(channel, "/todo", lanes.todo)
      patch(channel, "/done", lanes.done)
      patch(channel, "/moveNote", note ?? "The plugin refused the move")
    },
    orderItems: (action) => patch(channel, "/orderNote", "The plugin ordered by " + (Array.isArray(action.context.value) ? action.context.value.join(", ") : "nothing")),
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

function openProject(api: PluginApi, channel: SurfaceChannel) {
  const projectId = api.projects.currentId()
  const project = api.projects.list().find((candidate) => candidate.id === projectId)
  draw(channel, projectComponents, { project: project?.name ?? ${JSON.stringify(SURFACE_FIXTURE_NO_PROJECT)} })
}

function openSettings(channel: SurfaceChannel) {
  draw(channel, settingsComponents, { configuration: { harness: null, model: null, effort: null }, configured: "Harness: none" })
  return {
    action: (action: SurfaceActionEvent) => {
      const value = action.context.value as { harness: { id: string } | null } | undefined
      if (action.name === "configured") patch(channel, "/configured", "Harness: " + (value?.harness?.id ?? "none"))
    },
  }
}`

export function surfaceFixtureSource() {
  return `import { definePlugin, type PluginApi, type SurfaceActionEvent, type SurfaceChannel, type SurfaceComponent } from "@claxedo/plugin-api"

const CATALOG = "https://claxedo.dev/a2ui/v0.9/catalog.json"

${pageComponents}

${pageRules}

${pagePrograms}

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

export async function storeSurfaceFixtureImage(serverUrl: string, projectId: string, request: (url: string, init?: RequestInit) => Promise<Response>) {
  const client = createTasksClient({ baseUrl: new URL(TASKS_ROUTE_PATH, serverUrl).href, request })
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
