import {
  matchesDiagnosticsBinding,
  parseDiagnosticsTransportMessage,
  type DiagnosticsBinding,
  type DiagnosticsOperationRequest,
  type DiagnosticsOwnerDescriptor,
} from "../../shared/diagnostics-transport"
import type { OwnerOperation, OwnerOperationAnswer } from "./actions"

export function createOwnerOperationBridge(options: {
  binding: DiagnosticsBinding
  send(message: DiagnosticsOperationRequest): boolean
  timeoutMs?: number
  requestId?: () => string
}) {
  const pending = new Map<
    string,
    {
      resolve(answer: OwnerOperationAnswer): void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  let disposed = false

  const invoke: OwnerOperation = async (input) => {
    if (disposed || input.identity.creation.state !== "available") return { result: "owner-unavailable" }
    if (pending.size >= 256) return { result: "operation-failed" }
    const requestId = options.requestId?.() ?? crypto.randomUUID()
    const message: DiagnosticsOperationRequest = {
      type: "owner-operation-request",
      binding: options.binding,
      requestId,
      ownerOperationId: input.owner.ownerOperationId,
      ownerGeneration: input.owner.ownerGeneration,
      operation: input.action,
      identity: {
        pid: input.identity.pid,
        creation: input.identity.creation.value,
      },
    }
    return new Promise<OwnerOperationAnswer>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(requestId)
        resolve({ result: "operation-failed" })
      }, options.timeoutMs ?? 10_000)
      timer.unref?.()
      pending.set(requestId, { resolve, timer })
      if (options.send(message)) return
      clearTimeout(timer)
      pending.delete(requestId)
      resolve({ result: "owner-unavailable" })
    })
  }

  return {
    operationFor(descriptor: DiagnosticsOwnerDescriptor) {
      return (input: Parameters<OwnerOperation>[0]) => {
        if (
          input.owner.ownerId !== descriptor.ownerId ||
          input.owner.ownerGeneration !== descriptor.ownerGeneration ||
          input.owner.ownerOperationId !== descriptor.ownerOperationId
        ) return Promise.resolve({ result: "owner-unavailable" as const })
        return invoke(input)
      }
    },
    onMessage(input: unknown) {
      const parsed = parseDiagnosticsTransportMessage(input)
      if (
        !parsed.success ||
        parsed.data.type !== "owner-operation-result" ||
        !matchesDiagnosticsBinding(parsed.data.binding, options.binding)
      ) return false
      const request = pending.get(parsed.data.requestId)
      if (!request) return false
      clearTimeout(request.timer)
      pending.delete(parsed.data.requestId)
      request.resolve({
        result: parsed.data.result,
        ...(parsed.data.retirement ? { retirement: parsed.data.retirement } : {}),
      })
      return true
    },
    dispose() {
      disposed = true
      pending.forEach((request) => {
        clearTimeout(request.timer)
        request.resolve({ result: "owner-unavailable" })
      })
      pending.clear()
    },
  }
}
