import type { PluginApi } from "@claxedo/plugin-api"
import { unreachable } from "@/lib/machine"
import type { FrameResponse, HostCall } from "./protocol"

async function fetched(api: PluginApi, call: Extract<HostCall, { method: "server.fetch" }>): Promise<FrameResponse> {
  const response = await api.server.fetch(call.path, { method: call.init.method, headers: (call.init.headers ?? []).map(([name, value]): [string, string] => [name, value]), body: call.init.body })
  return { status: response.status, statusText: response.statusText, headers: [...response.headers.entries()], body: await response.text() }
}

export async function performCall(api: PluginApi, call: HostCall): Promise<unknown> {
  switch (call.method) {
    case "pages.open":
      return api.pages.open(call.pageId, call.params)
    case "overlays.open":
      return api.overlays.open(call.overlayId)
    case "overlays.close":
      return api.overlays.close(call.overlayId)
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
    case "server.fetch":
      return fetched(api, call)
    case "server.operation":
      return api.server.operation(call.name, call.input)
    case "ui.toast":
      return api.ui.toast(call.toast)
    case "ui.confirm":
      return api.ui.confirm(call.confirmation)
    default:
      return unreachable(call)
  }
}
