import { claxedoBus, globalBus, type ClaxedoEvent, type GlobalEvent } from "./lib/bus"

type Event =
  Extract<ClaxedoEvent, { type: "process.started" }>
  | Extract<ClaxedoEvent, { type: "process.stopped" }>
  | Extract<ClaxedoEvent, { type: "process.crashed" }>
  | Extract<ClaxedoEvent, { type: "process.status" }>
  | Extract<ClaxedoEvent, { type: "process.config.changed" }>

let once = false

function pick(event: ClaxedoEvent): Event | undefined {
  switch (event.type) {
    case "process.started":
    case "process.stopped":
    case "process.crashed":
    case "process.status":
    case "process.config.changed":
      return event
    default:
      return
  }
}

export function shape(event: ClaxedoEvent): GlobalEvent | undefined {
  const hit = pick(event)
  if (!hit?.directory) return
  const { type, directory, ...properties } = hit
  return {
    directory,
    payload: {
      type,
      properties,
    },
  }
}

export function mirrorProcessEvents() {
  if (once) return
  once = true
  claxedoBus.subscribe((event) => {
    const next = shape(event)
    if (next) globalBus.publish(next)
  })
}
