import path from "node:path"
import { writeLivePlugin, type LivePluginFolder } from "./live-plugins"

export const SURFACE_FIXTURE_ID = "surface-fixture"
export const SURFACE_FIXTURE_NAME = "Surface fixture"
export const SURFACE_FIXTURE_PATH = "/surface-fixture"

export function surfaceFixtureSource() {
  return `import { definePlugin, type SurfaceComponent } from "@claxedo/plugin-api"

const CATALOG = "https://claxedo.dev/a2ui/v0.9/catalog.json"

const components: SurfaceComponent[] = [
  { id: "root", component: "Column", children: ["title", "search", "items", "add"] },
  { id: "title", component: "Text", text: "Surface fixture", variant: "h2" },
  { id: "search", component: "TextField", label: "Search items", value: { path: "/query" } },
  { id: "items", component: "List", children: { componentId: "item", path: "/items" } },
  { id: "item", component: "Text", text: { path: "name" } },
  { id: "add", component: "Button", child: "add-label", variant: "primary", action: { event: { name: "addItem", context: { query: { path: "/query" } } } } },
  { id: "add-label", component: "Text", text: "Add item" },
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
          { version: "v0.9", updateDataModel: { surfaceId, path: "/", value: { query: "", items } } },
        )
        return {
          action(action) {
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
