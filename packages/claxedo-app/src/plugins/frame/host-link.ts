import { createEffect, createRoot } from "solid-js"
import type { PluginApi, SessionStatus } from "@claxedo/plugin-api"
import type { HostServices } from "../bindings"
import { sessionStatusOf } from "../bindings/data"
import { createHostPort, type FrameControl } from "./host-port"
import type { FrameMirror } from "./protocol"

export type HostLinkInput = {
  readonly port: MessagePort
  readonly api: PluginApi
  readonly services: HostServices
  readonly control?: FrameControl
}

export type HostLink = { readonly dispose: () => void }

export function frameMirror(api: PluginApi, services: HostServices): FrameMirror {
  const statuses: Record<string, SessionStatus> = {}
  const list = services.sessions.list
  for (const ref of list.order()) statuses[ref.sessionId] = sessionStatusOf(list.view(ref.sessionId))
  return {
    locale: api.context.locale,
    projects: api.projects.list(),
    currentProjectId: api.projects.currentId(),
    currentSession: api.context.currentSession(),
    tabs: api.workbench.tabs(),
    statuses,
  }
}

export function createHostLink(input: HostLinkInput): HostLink {
  const hostPort = createHostPort(input)
  const disposeMirror = createRoot((dispose) => {
    createEffect(() => hostPort.send({ type: "mirror", mirror: frameMirror(input.api, input.services) }))
    return dispose
  }, input.services.owner)
  return {
    dispose: () => {
      disposeMirror()
      hostPort.dispose()
    },
  }
}
