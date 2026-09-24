import type { QueryClient } from "@tanstack/solid-query"
import { batch } from "solid-js"
import { toAppError } from "./errors"
import type { ServerEvent } from "./events"
import { invalidateFor } from "./queries"
import type { StatusOwner } from "./status"
import type { SessionRef } from "./types"
import type { Workspaces } from "./workspaces"
import { createCoalescer, type Coalescer } from "./wire/coalesce"
import { frameOf, placementDirectory, serverEventFromFrame, type Frame } from "./wire/frames"

export type EventIntake = {
  readonly frame: (raw: unknown) => void
  readonly gap: () => void
  readonly subscribe: (listener: (event: ServerEvent) => void) => () => void
  readonly dispose: () => void
}

type IntakeInput = {
  readonly serverUrl: string
  readonly queryClient: QueryClient
  readonly workspaces: Workspaces
  readonly status: StatusOwner
}

type Listeners = Set<(event: ServerEvent) => void>

async function settleHeld(input: IntakeInput, ref: SessionRef, coalescer: Coalescer) {
  try {
    const status = await input.status.settle(await input.workspaces.route(ref), ref)
    coalescer.push({ type: "statusChanged", ref, status })
  } catch (error) {
    console.error("A session's status after its failed turn could not be settled", { sessionId: ref.sessionId, error: toAppError(error) })
  }
}

function publisher(input: IntakeInput, listeners: Listeners, coalescer: () => Coalescer) {
  return (events: readonly ServerEvent[]) => {
    batch(() => {
      for (const event of events) {
        const admission = input.status.apply(event)
        if (admission.kind === "held") {
          void settleHeld(input, admission.ref, coalescer())
          continue
        }
        invalidateFor(input.queryClient, input.serverUrl, admission.event)
        for (const listener of listeners) listener(admission.event)
      }
    })
  }
}

async function placed(workspaces: Workspaces, coalescer: Coalescer, frame: Frame): Promise<boolean> {
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

async function mapFrame(workspaces: Workspaces, coalescer: Coalescer, frame: Frame) {
  if (!(await placed(workspaces, coalescer, frame))) return
  const event = serverEventFromFrame(frame, workspaces.address)
  if (event) coalescer.push(event)
}

export function createEventIntake(input: IntakeInput): EventIntake {
  const listeners: Listeners = new Set()
  const coalescer: Coalescer = createCoalescer(publisher(input, listeners, () => coalescer))
  let queue: Promise<void> = Promise.resolve()
  return {
    frame: (raw) => {
      const frame = frameOf(raw)
      if (!frame) return console.error("The event stream sent a frame without a type", raw)
      queue = queue.then(() => mapFrame(input.workspaces, coalescer, frame))
    },
    gap: () => coalescer.push({ type: "streamGap" }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose: () => {
      coalescer.flush()
      listeners.clear()
    },
  }
}
