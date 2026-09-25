/// <reference types="bun" />
import { expect, test } from "bun:test"
import type { ServerEvent } from "../events"
import { placementId, projectId, sessionId } from "../ids"
import { createCoalescer, type Wake } from "./coalesce"

const refOf = (id: string) => ({ projectId: projectId("j1"), placementId: placementId("p1"), sessionId: sessionId(id) })
const delta = (id: string, text: string): ServerEvent => ({ type: "partDelta", ref: refOf(id), messageId: "m1", partId: "p1", field: "text", delta: text })

function scripted() {
  const asked: ("frame" | "later")[] = []
  const due: { kind: "frame" | "later"; run: () => void; cancelled: boolean }[] = []
  const schedule = (kind: "frame" | "later") => (run: () => void) => {
    asked.push(kind)
    const entry = { kind, run, cancelled: false }
    due.push(entry)
    return () => {
      entry.cancelled = true
    }
  }
  const wake: Wake = { frame: schedule("frame"), later: schedule("later") }
  const fire = (kind: "frame" | "later") => {
    for (const entry of due.filter((candidate) => candidate.kind === kind && !candidate.cancelled)) entry.run()
  }
  return { wake, asked, fire }
}

const onScreen = (event: ServerEvent) => !("ref" in event) || event.ref.sessionId === "shown"

test("coalesce: a background session's deltas wait for the no-frame flush and ask for no frame", () => {
  const clock = scripted()
  const emitted: (readonly ServerEvent[])[] = []
  const coalescer = createCoalescer((events) => emitted.push(events), onScreen, clock.wake)
  coalescer.push(delta("hidden", "a"))
  coalescer.push(delta("hidden", "b"))
  expect(clock.asked).toEqual(["later"])
  clock.fire("later")
  expect(emitted).toEqual([[delta("hidden", "ab")]])
})

test("coalesce: an on-screen event moves a waiting batch to the next frame, in order", () => {
  const clock = scripted()
  const emitted: (readonly ServerEvent[])[] = []
  const coalescer = createCoalescer((events) => emitted.push(events), onScreen, clock.wake)
  coalescer.push(delta("hidden", "a"))
  coalescer.push(delta("shown", "b"))
  coalescer.push(delta("hidden", "c"))
  expect(clock.asked).toEqual(["later", "frame"])
  clock.fire("later")
  expect(emitted).toEqual([])
  clock.fire("frame")
  expect(emitted).toEqual([[delta("hidden", "ac"), delta("shown", "b")]])
})

test("coalesce: an event that names no session asks for a frame", () => {
  const clock = scripted()
  const coalescer = createCoalescer(() => undefined, onScreen, clock.wake)
  coalescer.push({ type: "placementsChanged" })
  expect(clock.asked).toEqual(["frame"])
})
