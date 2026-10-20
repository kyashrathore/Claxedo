import { failureReason } from "../failure"

export class FrameCallError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = "FrameCallError"
  }
}

export type Settled = { readonly id: number; readonly ok: true; readonly value: unknown } | { readonly id: number; readonly ok: false; readonly reason: string }

export type CallProgressListener = (text: string | undefined) => void

export type PendingCalls = {
  readonly open: (progress?: CallProgressListener) => { readonly id: number; readonly result: Promise<unknown> }
  readonly progress: (id: number, text: string | undefined) => void
  readonly settle: (settled: Settled) => void
  readonly failAll: (reason: string) => void
}

export function createPendingCalls(): PendingCalls {
  const pending = new Map<number, { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void; readonly progress?: CallProgressListener }>()
  let next = 1
  return {
    open: (progress) => {
      const id = next++
      const result = new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject, progress }))
      return { id, result }
    },
    progress: (id, text) => pending.get(id)?.progress?.(text),
    settle: (settled) => {
      const waiting = pending.get(settled.id)
      if (!waiting) return
      pending.delete(settled.id)
      if (settled.ok) waiting.resolve(settled.value)
      else waiting.reject(new FrameCallError(settled.reason))
    },
    failAll: (reason) => {
      for (const waiting of pending.values()) waiting.reject(new FrameCallError(reason))
      pending.clear()
    },
  }
}

export type CallResult = { readonly type: "result" } & Settled

export async function answerCall(send: (result: CallResult) => void, id: number, work: () => unknown): Promise<void> {
  try {
    send({ type: "result", id, ok: true, value: await work() })
  } catch (error) {
    send({ type: "result", id, ok: false, reason: failureReason(error) })
  }
}
