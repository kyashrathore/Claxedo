import type { QueryClient } from "@tanstack/solid-query"
import { batch } from "solid-js"
import { toAppError } from "./errors"
import type { ServerEvent } from "./events"
import { invalidateFor } from "./queries"
import type { StatusOwner } from "./status"
import type { Workspaces } from "./workspaces"
import { createCoalescer } from "./wire/coalesce"
import { frameOf, placementDirectory, serverEventFromFrame, type Frame } from "./wire/frames"

export type EventIntake = {
  readonly frame: (raw: unknown) => void
  readonly gap: () => void
  readonly subscribe: (listener: (event: ServerEvent) => void) => () => void
  readonly dispose: () => void
}

export function createEventIntake(input: {
  readonly serverUrl: string
  readonly queryClient: QueryClient
  readonly workspaces: Workspaces
  readonly status: StatusOwner
}): EventIntake {
  const { workspaces } = input
  const listeners = new Set<(event: ServerEvent) => void>()
  const publish = (events: readonly ServerEvent[]) => {
    batch(() => {
      for (const event of events) {
        const admitted = input.status.apply(event)
        if (!admitted) continue
        invalidateFor(input.queryClient, input.serverUrl, admitted)
        for (const listener of listeners) listener(admitted)
      }
    })
  }
  const coalescer = createCoalescer(publish)
  let queue: Promise<void> = Promise.resolve()

  const learnPlacement = async (frame: Frame) => {
    const directory = placementDirectory(frame)
    if (!directory || workspaces.address.placementFor(directory, frame.workspaceId)) return true
    try {
      await workspaces.learn(directory)
      return true
    } catch (error) {
      console.error("The placement catalog could not be re-read for an event frame", { type: frame.type, directory, error: toAppError(error) })
      coalescer.push({ type: "streamGap" })
      return false
    }
  }

  const map = async (frame: Frame) => {
    if (!(await learnPlacement(frame))) return
    const event = serverEventFromFrame(frame, workspaces.address)
    if (event) coalescer.push(event)
  }

  return {
    frame: (raw) => {
      const frame = frameOf(raw)
      if (!frame) {
        console.error("The event stream sent a frame without a type", raw)
        return
      }
      queue = queue.then(() => map(frame))
    },
    gap: () => coalescer.push({ type: "streamGap" }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose: () => {
      coalescer.flush()
      listeners.clear()
    },
  }
}
