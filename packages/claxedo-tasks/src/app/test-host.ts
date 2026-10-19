import { Hono } from "hono"
import type {
  PageDefinition,
  PluginApi,
  ServerApi,
  SettingsSectionDefinition,
  SidebarItem,
  SurfaceActionEvent,
  SurfaceChannel,
  SurfaceComponent,
  SurfaceMessage,
  ToolCardTemplate,
} from "@claxedo/plugin-api"
import { checkSurfaceSpec, componentReferences, surfaceMessageSchema } from "@claxedo/plugin-api/surface"
import { TASKS_ROUTE_PATH } from "../contracts"
import { createTasksRoutes } from "../http/routes"
import { createMemoryTasksStore } from "../stores/memory"
import { ACTOR, fakeAuthorization, fakeBridge, fakeCapabilities, fakeClock, fakeIds } from "../test-support/fakes"
import { dictionary, type TasksKey, type Translate } from "./dictionary"
import { tasksClientOf } from "./tasks-client"
import type { Json, JsonObject } from "./surface/json"

export const englishWords: Translate = (key, params) =>
  dictionary.en[key].replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, name: string) => (params?.[name] === undefined ? match : String(params[name])))

function pointerKeys(path: string): string[] {
  return path === "/" ? [] : path.split("/").slice(1).map((key) => key.replaceAll("~1", "/").replaceAll("~0", "~"))
}

function isPlainJsonObject(value: Json | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isTasksKey(key: string): key is TasksKey {
  return key in dictionary.en
}

function writeData(model: JsonObject, path: string, value: Json | undefined): JsonObject {
  const keys = pointerKeys(path)
  if (keys.length === 0) return isPlainJsonObject(value) ? value : {}
  let cursor: Record<string, Json> | Json[] = model
  for (const key of keys.slice(0, -1)) {
    const next: Json | undefined = Array.isArray(cursor) ? cursor[Number(key)] : cursor[key]
    if (next === null || typeof next !== "object") {
      const created: JsonObject = {}
      if (Array.isArray(cursor)) cursor[Number(key)] = created
      else cursor[key] = created
      cursor = created
    } else cursor = next
  }
  const last = keys[keys.length - 1] ?? ""
  if (Array.isArray(cursor)) {
    if (value === undefined) cursor.splice(Number(last), 1)
    else cursor[Number(last)] = value
  } else if (value === undefined) delete cursor[last]
  else cursor[last] = value
  return model
}

export type RecordedSurface = SurfaceChannel & {
  readonly messages: SurfaceMessage[]
  readonly components: Map<string, SurfaceComponent>
  data: JsonObject
  readonly read: (path: string) => Json | undefined
  readonly write: (path: string, value: Json) => void
  readonly check: () => ReturnType<typeof checkSurfaceSpec>
  readonly component: (id: string) => SurfaceComponent | undefined
}

export function recordedSurface(surfaceId = "surface-1"): RecordedSurface {
  const surface: RecordedSurface = {
    surfaceId,
    messages: [],
    components: new Map(),
    data: {},
    send: (...messages) => {
      for (const message of messages) {
        const parsed = surfaceMessageSchema.parse(message)
        surface.messages.push(parsed)
        if ("updateComponents" in parsed) for (const component of parsed.updateComponents.components) surface.components.set(component.id, component)
        if ("updateDataModel" in parsed) surface.data = writeData(surface.data, parsed.updateDataModel.path ?? "/", parsed.updateDataModel.value)
      }
    },
    read: (path) => pointerKeys(path).reduce<Json | undefined>((value, key) => (value !== null && typeof value === "object" ? (Array.isArray(value) ? value[Number(key)] : value[key]) : undefined), surface.data),
    write: (path, value) => {
      surface.data = writeData(surface.data, path, value)
    },
    check: () => checkSurfaceSpec({ title: "Recorded surface", components: [...surface.components.values()], data: surface.data }),
    component: (id) => surface.components.get(id),
  }
  return surface
}

export function tasksServer() {
  const store = createMemoryTasksStore()
  const bridge = fakeBridge()
  const host = new Hono()
  host.route(
    TASKS_ROUTE_PATH,
    createTasksRoutes({ store, authorization: fakeAuthorization(), authenticate: () => ({ actor: ACTOR }), bridge, capabilities: fakeCapabilities(), clock: fakeClock(), ids: fakeIds() }),
  )
  const requests: string[] = []
  const server: ServerApi = {
    fetch: async (path, init) => {
      requests.push(`${init?.method ?? "GET"} ${path}`)
      return host.request(`http://tasks.test${path}`, init)
    },
    operation: async () => undefined,
  }
  return { server, store, bridge, requests, client: tasksClientOf(server) }
}

export type Registrations = {
  readonly toolCards: ToolCardTemplate[]
  readonly pages: PageDefinition[]
  readonly sidebar: SidebarItem[]
  readonly settings: SettingsSectionDefinition[]
}

export function recordingPluginApi(server: ServerApi = tasksServer().server): { readonly api: PluginApi; readonly registered: Registrations } {
  const registered: Registrations = { toolCards: [], pages: [], sidebar: [], settings: [] }
  const disposer = () => () => undefined
  const api = {
    transcript: { toolCards: (templates: readonly ToolCardTemplate[]) => (registered.toolCards.push(...templates), disposer()) },
    pages: { register: (page: PageDefinition) => (registered.pages.push(page), disposer()), open: () => undefined },
    sidebar: { item: (item: SidebarItem) => (registered.sidebar.push(item), disposer()) },
    settings: { section: (section: SettingsSectionDefinition) => (registered.settings.push(section), disposer()), open: () => undefined },
    i18n: { t: (key: string, params?: Readonly<Record<string, string | number>>) => (isTasksKey(key) ? englishWords(key, params) : key) },
    ui: { toast: () => undefined, confirm: async () => true },
    server,
  }
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return { api: api as unknown as PluginApi, registered }
}

export async function actionsSettled(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

export function surfaceAction(name: string, context: Readonly<Record<string, Json | undefined>> = {}, sourceComponentId = "test"): SurfaceActionEvent {
  const defined = Object.fromEntries(Object.entries(context).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])))
  return { name, surfaceId: "surface-1", sourceComponentId, timestamp: new Date(0).toISOString(), context: defined }
}

export function reachableIds(surface: RecordedSurface, from = "root"): Set<string> {
  const seen = new Set<string>()
  const pending = [from]
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    const component = surface.components.get(id)
    if (seen.has(id) || !component) continue
    seen.add(id)
    pending.push(...componentReferences(component).map((reference) => reference.id))
  }
  return seen
}
