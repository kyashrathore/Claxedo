import path from "node:path"
import { writeLivePlugin, type LivePluginFolder } from "./live-plugins"

export const SURFACE_FIXTURE_ID = "surface-fixture"
export const SURFACE_FIXTURE_NAME = "Surface fixture"
export const SURFACE_FIXTURE_PATH = "/surface-fixture"
export const SURFACE_FIXTURE_PICTURE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGNQTX5NEmIY1TCqYfhqAAB2SXMQ7mVTQgAAAABJRU5ErkJggg=="
export const SURFACE_FIXTURE_REMOTE_PICTURE = "https://images.invalid/fixture.png"

export function surfaceFixtureSource() {
  return `import { definePlugin, type SurfaceComponent } from "@claxedo/plugin-api"

const CATALOG = "https://claxedo.dev/a2ui/v0.9/catalog.json"

const components: SurfaceComponent[] = [
  { id: "root", component: "Column", children: ["title", "search", "items", "add", "pictures", "order", "order-note", "board", "move-note", "attachments", "project", "project-note"] },
  { id: "title", component: "Text", text: "Surface fixture", variant: "h2" },
  { id: "search", component: "TextField", label: "Search items", value: { path: "/query" } },
  { id: "items", component: "List", children: { componentId: "item", path: "/items" } },
  { id: "item", component: "Text", text: { path: "name" } },
  { id: "add", component: "Button", child: "add-label", variant: "primary", action: { event: { name: "addItem", context: { query: { path: "/query" } } } } },
  { id: "add-label", component: "Text", text: "Add item" },
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
  {
    id: "attach",
    component: "FilePicker",
    label: "Attach images",
    accept: ["image/png", "image/jpeg"],
    maxBytes: 4096,
    maxFiles: 3,
    paste: "section",
    pick: { event: { name: "attachImages" } },
  },
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

const PROJECTS = [
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

export default definePlugin({
  activate(api) {
    api.sidebar.item({ id: "surface", label: ${JSON.stringify(SURFACE_FIXTURE_NAME)}, pageId: "surface" })
    api.pages.register({
      id: "surface",
      path: ${JSON.stringify(SURFACE_FIXTURE_PATH)},
      title: ${JSON.stringify(SURFACE_FIXTURE_NAME)},
      surface(channel) {
        const { surfaceId } = channel
        const items = [{ name: "First item" }]
        const lanes = { todo: [{ id: "c1", title: "First card" }, { id: "c2", title: "Second card" }], done: [{ id: "c3", title: "Third card" }] }
        channel.send(
          { version: "v0.9", createSurface: { surfaceId, catalogId: CATALOG } },
          { version: "v0.9", updateComponents: { surfaceId, components } },
          { version: "v0.9", updateDataModel: { surfaceId, path: "/", value: { query: "", items, picture: ${JSON.stringify(SURFACE_FIXTURE_PICTURE)}, order: ["oldest"], orderNote: "Ordered oldest first", ...lanes, moveNote: "No card moved yet", attached: [], attachNote: "No images yet", project: "", projectQuery: "", projects: PROJECTS, projectNote: "No project chosen" } } },
        )
        return {
          action(action) {
            if (action.name === "attachImages") {
              channel.send(
                { version: "v0.9", updateDataModel: { surfaceId, path: "/attached", value: attached(action.context.files) } },
                { version: "v0.9", updateDataModel: { surfaceId, path: "/attachNote", value: refusals(action.context.refused) } },
              )
              return
            }
            if (action.name === "findProjects") {
              const query = String(action.context.query).toLowerCase()
              const found = PROJECTS.filter((project) => project.label.toLowerCase().includes(query))
              channel.send({ version: "v0.9", updateDataModel: { surfaceId, path: "/projects", value: found } })
              return
            }
            if (action.name === "chooseProject") {
              channel.send({ version: "v0.9", updateDataModel: { surfaceId, path: "/projectNote", value: "Chose " + String(action.context.value) } })
              return
            }
            if (action.name === "moveCard") {
              const note = moveCard(lanes, action.context)
              channel.send(
                { version: "v0.9", updateDataModel: { surfaceId, path: "/todo", value: lanes.todo } },
                { version: "v0.9", updateDataModel: { surfaceId, path: "/done", value: lanes.done } },
                { version: "v0.9", updateDataModel: { surfaceId, path: "/moveNote", value: note ?? "The plugin refused the move" } },
              )
              return
            }
            if (action.name === "orderItems") {
              const order = Array.isArray(action.context.value) ? action.context.value.join(", ") : "nothing"
              channel.send({ version: "v0.9", updateDataModel: { surfaceId, path: "/orderNote", value: "The plugin ordered by " + order } })
              return
            }
            if (action.name !== "addItem") return
            const query = typeof action.context.query === "string" ? action.context.query.trim() : ""
            const item = { name: query || "Item " + (items.length + 1) }
            items.push(item)
            channel.send({ version: "v0.9", updateDataModel: { surfaceId, path: "/items/" + (items.length - 1), value: item } })
          },
        }
      },
    })
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
