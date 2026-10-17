import type { Disposer, PluginApi } from "@claxedo/plugin-api"
import { failureReason } from "../failure"
import { performCall } from "./host-calls"
import { registerOnHost, type FrameEndpoints, type FrameSlots, type Invoke } from "./host-registrations"
import { createSurfaceRoutes } from "./host-surfaces"
import type { FrameToHost, HostToFrame, Registration } from "./protocol"
import { answerCall, createPendingCalls } from "./pending-calls"

export type FrameControl = {
  readonly slots: FrameSlots
  readonly activated: () => void
  readonly failed: (reason: string) => void
}

export type HostPortInput = {
  readonly port: MessagePort
  readonly api: PluginApi
  readonly control?: FrameControl
}

export type HostPort = {
  readonly send: (message: HostToFrame) => void
  readonly dispose: () => void
}

function createFrameRegistrations(api: PluginApi, control: FrameControl | undefined, endpoints: Omit<FrameEndpoints, "slots">) {
  const registered = new Map<number, Disposer>()
  return {
    register: (key: number, registration: Registration) => {
      if (!control) return
      try {
        registered.set(key, registerOnHost(api, registration, { ...endpoints, slots: control.slots }))
      } catch (error) {
        control.failed(failureReason(error))
      }
    },
    unregister: (key: number) => {
      registered.get(key)?.()
      registered.delete(key)
    },
    disposeAll: () => {
      for (const dispose of registered.values()) dispose()
      registered.clear()
    },
  }
}

export function createHostPort(input: HostPortInput): HostPort {
  const { port, api, control } = input
  const requests = createPendingCalls()
  const send = (message: HostToFrame) => port.postMessage(message)
  const invoke: Invoke = (frameInvoke) => {
    const { id, result } = requests.open()
    send({ type: "invoke", id, invoke: frameInvoke })
    return result
  }
  const surfaces = createSurfaceRoutes((error) => control?.failed(failureReason(error)))
  const registrations = createFrameRegistrations(api, control, { invoke, surfaces })
  const receive = (message: FrameToHost) => {
    if (message.type === "register") return registrations.register(message.key, message.registration)
    if (message.type === "unregister") return registrations.unregister(message.key)
    if (message.type === "surface") return surfaces.deliver(message)
    if (message.type === "call") return void answerCall(send, message.id, () => performCall(api, message.call))
    if (message.type === "result") return requests.settle(message)
    if (message.type === "activated") return control?.activated()
    control?.failed(message.reason)
  }
  port.onmessage = (event: MessageEvent<FrameToHost>) => receive(event.data)
  return {
    send,
    dispose: () => {
      registrations.disposeAll()
      surfaces.detachAll()
      requests.failAll("The plugin frame closed")
      port.close()
    },
  }
}
