import type { JSX } from "solid-js"
import type { Disposer, MentionInsert, PluginApi } from "@claxedo/plugin-api"
import { unreachable } from "@/lib/machine"
import { frameSurfacePage, type SurfaceRoutes } from "./host-surfaces"
import { foundMentionsFromFrame, type FrameInvoke, type Registration, type RenderTarget } from "./protocol"

export type FrameSlots = (target: RenderTarget, title: string) => JSX.Element

export type Invoke = (invoke: FrameInvoke) => Promise<unknown>

export type FrameEndpoints = {
  readonly slots: FrameSlots
  readonly invoke: Invoke
  readonly surfaces: SurfaceRoutes
}

function registerMention(api: PluginApi, registration: Extract<Registration, { kind: "mention" }>, invoke: Invoke): Disposer {
  const inserts = new Map<string, MentionInsert>()
  return api.mentions.register({
    id: registration.id,
    label: registration.label,
    search: async (query, context) => {
      const found = foundMentionsFromFrame(await invoke({ method: "mention.search", mentionId: registration.id, query, context }))
      for (const { item, insert } of found) inserts.set(item.id, insert)
      return found.map(({ item }) => item)
    },
    insert: (item) => {
      const insert = inserts.get(item.id)
      if (!insert) throw new Error(`The mention ${item.id} was not offered by ${registration.id}`)
      return insert
    },
  })
}

function registerFramePage(api: PluginApi, registration: Extract<Registration, { kind: "page" }>, endpoints: FrameEndpoints): Disposer {
  if (registration.surface) return api.pages.register(frameSurfacePage(registration, endpoints.surfaces, endpoints.invoke))
  const { id, path, title } = registration
  return api.pages.register({ id, path, title, render: (props) => endpoints.slots({ kind: "page", id, path: props.path, params: props.params }, title) })
}

export function registerOnHost(api: PluginApi, registration: Registration, endpoints: FrameEndpoints): Disposer {
  const { slots, invoke } = endpoints
  switch (registration.kind) {
    case "sidebar":
      return api.sidebar.item(registration)
    case "page":
      return registerFramePage(api, registration, endpoints)
    case "settings":
      return api.settings.section({ ...registration, render: () => slots({ kind: "settings", id: registration.id }, registration.title) })
    case "overlay":
      return api.overlays.register({ ...registration, render: () => slots({ kind: "overlay", id: registration.id }, registration.id) })
    case "command":
      return api.commands.register({
        ...registration,
        run: async (context) => {
          await invoke({ method: "command.run", commandId: registration.id, context })
        },
      })
    case "mention":
      return registerMention(api, registration, invoke)
    case "theme":
      return api.themes.register(registration.theme)
    default:
      return unreachable(registration)
  }
}
