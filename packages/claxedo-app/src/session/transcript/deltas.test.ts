/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { placementId, projectId, sessionId } from "@/server"
import { committingFirst, createDeltaBuffer, type PartDelta } from "./deltas"
import { emptyTranscript } from "./model"

const ref = { projectId: projectId("j1"), placementId: placementId("p1"), sessionId: sessionId("s1") }
const delta = (text: string, partId = "p1"): PartDelta => ({ type: "partDelta", ref, messageId: "m1", partId, field: "text", delta: text })

test("deltas: held deltas merge per field and apply only when committed", () => {
  createRoot((dispose) => {
    const applied: PartDelta[] = []
    const deltas = createDeltaBuffer((held) => applied.push(held))
    deltas.add(delta("a"))
    deltas.add(delta("x", "p2"))
    deltas.add(delta("b"))
    expect(deltas.pending()).toBe(true)
    expect(applied).toEqual([])
    deltas.commit()
    expect(applied).toEqual([delta("ab"), delta("x", "p2")])
    expect(deltas.pending()).toBe(false)
    dispose()
  })
})

test("deltas: any other write commits the held deltas before it lands", () => {
  createRoot((dispose) => {
    const [, setData] = createStore(emptyTranscript())
    const order: string[] = []
    const deltas = createDeltaBuffer((held) => order.push(`delta ${held.delta}`))
    const write = committingFirst(setData, deltas)
    deltas.add(delta("streamed"))
    write("diff", [])
    order.push("write")
    expect(order).toEqual(["delta streamed", "write"])
    expect(deltas.pending()).toBe(false)
    dispose()
  })
})
