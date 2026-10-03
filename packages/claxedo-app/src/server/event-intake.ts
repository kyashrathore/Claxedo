import type { QueryClient } from "@tanstack/solid-query"
import { batch } from "solid-js"
import { toAppError } from "./errors"
import type { ServerEvent } from "./events"
import { invalidateFor } from "./queries"
import type { StatusOwner } from "./status"
import { createTurnWrites, type TurnWrites } from "./turn-writes"
import type { Workspaces } from "./workspaces"
import type { SessionLocation } from "./types"
import { frameFromWire, frameSessionId, placementDirectory, serverEventFromFrame, STATUS_NOTICE, type Frame } from "./wire/frames"

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
  readonly streamed: (ref: SessionLocation) => boolean
}

type Listeners = Set<(event: ServerEvent) => void>

type Publish = (event: ServerEvent) => void

async function settleHeld(input: IntakeInput, held: Extract<ServerEvent, { type: "statusChanged" }>, publish: Publish) {
  const { ref } = held
  try {
    const status = await input.status.settle(await input.workspaces.route(ref), ref)
    publish({ ...held, status })
  } catch (error) {
    console.error("A session's status after its failed turn could not be settled", { sessionId: ref.sessionId, error: toAppError(error) })
  }
}

function publisher(input: IntakeInput, listeners: Listeners, writes: TurnWrites): Publish {
  const publish: Publish = (event) => {
    const admission = input.status.apply(event)
    if (admission.kind === "held") {
      void settleHeld(input, admission.event, publish)
      return
    }
    batch(() => {
      invalidateFor(input.queryClient, input.serverUrl, admission.event, writes.endsWritingTurn(admission.event))
      for (const listener of listeners) listener(admission.event)
    })
  }
  return publish
}

function unplacedDirectory(workspaces: Workspaces, frame: Frame): string | undefined {
  const directory = placementDirectory(frame)
  return directory && !workspaces.address.placementFor(directory, frame.workspaceId, frameSessionId(frame)) ? directory : undefined
}

function mapFrame(input: IntakeInput, publish: Publish, frame: Frame): void {
  const event = serverEventFromFrame(frame, input.workspaces.address)
  if (!event) return
  if (frame.type === STATUS_NOTICE && "ref" in event && input.streamed(event.ref)) return
  publish(event)
}

async function learnThenMap(input: IntakeInput, publish: Publish, frame: Frame, directory: string) {
  try {
    await input.workspaces.learn(directory)
  } catch (error) {
    console.error("The placement catalog could not be re-read for an event frame", { type: frame.type, directory, error: toAppError(error) })
    return publish({ type: "streamGap" })
  }
  mapFrame(input, publish, frame)
}

export function createEventIntake(input: IntakeInput): EventIntake {
  const listeners: Listeners = new Set()
  const publish = publisher(input, listeners, createTurnWrites())
  let learning: Promise<void> | undefined
  const mapInOrder = (frame: Frame) => {
    const unplaced = unplacedDirectory(input.workspaces, frame)
    return unplaced ? learnThenMap(input, publish, frame, unplaced) : mapFrame(input, publish, frame)
  }
  const intake = (frame: Frame) => {
    if (!learning && !unplacedDirectory(input.workspaces, frame)) return mapFrame(input, publish, frame)
    const tail = (learning ?? Promise.resolve()).then(() => mapInOrder(frame))
    learning = tail
    void tail.then(() => {
      if (learning === tail) learning = undefined
    })
  }
  return {
    frame: (raw) => {
      const frame = frameFromWire(raw)
      if (!frame) return console.error("The event stream sent a frame without a type", raw)
      intake(frame)
    },
    gap: () => publish({ type: "streamGap" }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose: () => listeners.clear(),
  }
}
