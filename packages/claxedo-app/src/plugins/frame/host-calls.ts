import type { PluginApi } from "@claxedo/plugin-api"
import { unreachable } from "@/lib/machine"
import type { FrameRequestInit, HostCall } from "./protocol"
import { frameResponseOf } from "./response-body"

export type CallProgress = (text: string | undefined) => void

function requestInitOf(init: FrameRequestInit): RequestInit {
  const headers = (init.headers ?? []).map(([name, value]): [string, string] => [name, value])
  return { method: init.method, headers, body: init.body }
}

async function fetched(api: PluginApi, call: Extract<HostCall, { method: "server.fetch" }>) {
  return frameResponseOf(await api.server.fetch(call.path, requestInitOf(call.init)))
}

async function fetchedFromBackend(api: PluginApi, call: Extract<HostCall, { method: "server.backend.fetch" }>) {
  return frameResponseOf(await api.server.backend().fetch(call.path, requestInitOf(call.init)))
}

export async function performCall(api: PluginApi, call: HostCall, progress: CallProgress): Promise<unknown> {
  switch (call.method) {
    case "pages.open":
      return api.pages.open(call.pageId, call.params)
    case "overlays.open":
      return api.overlays.open(call.overlayId)
    case "overlays.close":
      return api.overlays.close(call.overlayId)
    case "settings.open":
      return api.settings.open(call.sectionId)
    case "commands.run":
      return api.commands.run(call.commandId)
    case "workbench.activate":
      return api.workbench.activate(call.tabId)
    case "workbench.close":
      return api.workbench.close(call.tabId)
    case "workbench.move":
      return api.workbench.move(call.tabId, call.index)
    case "sessions.create":
      return api.sessions.create(call.input)
    case "sessions.open":
      return api.sessions.open(call.ref)
    case "workspaces.followStart":
      return api.workspaces.followStart(call.workspaceId, progress)
    case "server.fetch":
      return fetched(api, call)
    case "server.operation":
      return api.server.operation(call.name, call.input)
    case "server.backend.fetch":
      return fetchedFromBackend(api, call)
    case "ui.toast":
      return api.ui.toast(call.toast)
    case "ui.confirm":
      return api.ui.confirm(call.confirmation)
    default:
      return unreachable(call)
  }
}
