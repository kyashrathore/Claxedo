import { createStore, reconcile } from "solid-js/store"
import { failureReason } from "../../failure"
import type { FrameInvoke, FrameMirror, FrameToHost, HostCall, HostToFrame, Registration } from "../protocol"
import { createPendingCalls } from "../pending-calls"

export type InvokeHandler = (invoke: FrameInvoke) => unknown

export type FrameLink = {
  readonly mirror: FrameMirror
  readonly call: (call: HostCall) => Promise<unknown>
  readonly register: (registration: Registration) => () => void
  readonly send: (message: FrameToHost) => void
  readonly onInvoke: (handler: InvokeHandler) => void
}

export function createFrameLink(port: MessagePort, initial: FrameMirror): FrameLink {
  const [mirror, setMirror] = createStore<FrameMirror>(initial)
  const requests = createPendingCalls()
  const send = (message: FrameToHost) => port.postMessage(message)
  let invokeHandler: InvokeHandler | undefined
  let nextKey = 1

  const answer = async (id: number, invoke: FrameInvoke) => {
    try {
      if (!invokeHandler) throw new Error("This frame renders a slot and runs no commands")
      send({ type: "result", id, ok: true, value: await invokeHandler(invoke) })
    } catch (error) {
      send({ type: "result", id, ok: false, reason: failureReason(error) })
    }
  }

  port.onmessage = (event: MessageEvent<HostToFrame>) => {
    const message = event.data
    if (message.type === "mirror") setMirror(reconcile(message.mirror))
    else if (message.type === "invoke") void answer(message.id, message.invoke)
    else requests.settle(message)
  }

  return {
    mirror,
    call: (call) => {
      const { id, result } = requests.open()
      send({ type: "call", id, call })
      return result
    },
    register: (registration) => {
      const key = nextKey++
      send({ type: "register", key, registration })
      return () => send({ type: "unregister", key })
    },
    send,
    onInvoke: (handler) => {
      invokeHandler = handler
    },
  }
}
