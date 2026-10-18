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
  { id: "root", component: "Column", children: ["title", "search", "items", "add", "pictures", "order", "order-note"] },
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
]

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
        channel.send(
          { version: "v0.9", createSurface: { surfaceId, catalogId: CATALOG } },
          { version: "v0.9", updateComponents: { surfaceId, components } },
          { version: "v0.9", updateDataModel: { surfaceId, path: "/", value: { query: "", items, picture: ${JSON.stringify(SURFACE_FIXTURE_PICTURE)}, order: ["oldest"], orderNote: "Ordered oldest first" } } },
        )
        return {
          action(action) {
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
