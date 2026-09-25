import { batch, createSignal, type Accessor } from "solid-js"
import type { ServerEvent } from "@/server"
import type { SetTranscript } from "./conversation"

export type PartDelta = Extract<ServerEvent, { type: "partDelta" }>

export type DeltaBuffer = {
  readonly pending: Accessor<boolean>
  readonly add: (delta: PartDelta) => void
  readonly commit: () => void
}

const fieldKey = (delta: PartDelta) => `${delta.messageId}:${delta.partId}:${delta.field}`

export function createDeltaBuffer(apply: (delta: PartDelta) => void): DeltaBuffer {
  let held = new Map<string, PartDelta>()
  const [pending, setPending] = createSignal(false)
  return {
    pending,
    add: (delta) => {
      const key = fieldKey(delta)
      const earlier = held.get(key)
      held.set(key, earlier ? { ...earlier, delta: earlier.delta + delta.delta } : delta)
      setPending(true)
    },
    commit: () => {
      const committed = held
      held = new Map()
      batch(() => {
        setPending(false)
        for (const delta of committed.values()) apply(delta)
      })
    },
  }
}

export function committingFirst(set: SetTranscript, deltas: DeltaBuffer): SetTranscript {
  return ((...args: unknown[]) => {
    deltas.commit()
    Reflect.apply(set, undefined, args)
  }) as SetTranscript
}
