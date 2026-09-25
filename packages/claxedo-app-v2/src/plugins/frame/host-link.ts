import { createEffect, createRoot } from "solid-js"
import type { Disposer, PluginApi, SessionStatus } from "@claxedo/plugin-api"
import type { HostServices } from "../bindings"
import { sessionStatusOf } from "../bindings/data"
import { failureReason } from "../failure"
import { performCall } from "./host-calls"
import { registerOnHost, type FrameSlots, type Invoke } from "./host-registrations"
import type { FrameMirror, FrameToHost, HostCall, HostToFrame } from "./protocol"
import { createPendingCalls } from "./pending-calls"

export type FrameControl = {
  readonly slots: FrameSlots
  readonly activated: () => void
  readonly failed: (reason: string) => void
}

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
  const { port, api, control } = input
  const requests = createPendingCalls()
  const registered = new Map<number, Disposer>()
  const send = (message: HostToFrame) => port.postMessage(message)
  const invoke: Invoke = (frameInvoke) => {
    const { id, result } = requests.open()
    send({ type: "invoke", id, invoke: frameInvoke })
    return result
  }
  const answer = async (id: number, call: HostCall) => {
    try {
      send({ type: "result", id, ok: true, value: await performCall(api, call) })
    } catch (error) {
      send({ type: "result", id, ok: false, reason: failureReason(error) })
    }
  }
  const register = (key: number, message: Extract<FrameToHost, { type: "register" }>) => {
    if (!control) return
    try {
      registered.set(key, registerOnHost(api, message.registration, control.slots, invoke))
    } catch (error) {
      control.failed(failureReason(error))
    }
  }
  const receive = (message: FrameToHost) => {
    if (message.type === "register") return register(message.key, message)
    if (message.type === "unregister") {
      registered.get(message.key)?.()
      return registered.delete(message.key)
    }
    if (message.type === "call") return void answer(message.id, message.call)
    if (message.type === "result") return requests.settle(message)
    if (message.type === "activated") return control?.activated()
    control?.failed(message.reason)
  }
  port.onmessage = (event: MessageEvent<FrameToHost>) => receive(event.data)
  const disposeMirror = createRoot((dispose) => {
    createEffect(() => send({ type: "mirror", mirror: frameMirror(api, input.services) }))
    return dispose
  }, input.services.owner)
  return {
    dispose: () => {
      disposeMirror()
      for (const dispose of registered.values()) dispose()
      registered.clear()
      requests.failAll("The plugin frame closed")
      port.close()
    },
  }
}
