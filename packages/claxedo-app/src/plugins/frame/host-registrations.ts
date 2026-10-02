import type { JSX } from "solid-js"
import type { Disposer, MentionInsert, PluginApi } from "@claxedo/plugin-api"
import { unreachable } from "@/lib/machine"
import { foundMentionsFromFrame, type FrameInvoke, type Registration, type RenderTarget } from "./protocol"

export type FrameSlots = (target: RenderTarget, title: string) => JSX.Element

export type Invoke = (invoke: FrameInvoke) => Promise<unknown>

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

export function registerOnHost(api: PluginApi, registration: Registration, slots: FrameSlots, invoke: Invoke): Disposer {
  switch (registration.kind) {
    case "sidebar":
      return api.sidebar.item(registration)
    case "page":
      return api.pages.register({ ...registration, render: (props) => slots({ kind: "page", id: registration.id, path: props.path, params: props.params }, registration.title) })
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
