/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { surfaceActionEventSchema } from "@claxedo/plugin-api/surface"
import { surfaceActionEvent } from "./action"
import { createBoundValue, boundText } from "./binding"
import { createSurfaceData } from "./data-model"
import { itemScope } from "./data-path"

function form() {
  const data = createSurfaceData()
  data.write([], { name: "api", tags: ["a", "b"], rows: [{ id: "r1" }, { id: "r2" }] })
  return data
}

test("an action resolves its context at the moment it fires, from literals, absolute and relative paths", () => {
  const data = form()
  const action = { event: { name: "save", context: { name: { path: "/name" }, row: { path: "id" }, kind: "deploy", missing: { path: "/nope" } } } }
  const event = surfaceActionEvent(action, { surfaceId: "s1", sourceComponentId: "save", scope: itemScope(["rows"], 1) }, data, new Date("2026-10-17T10:00:00Z"))
  expect(event).toEqual({
    name: "save",
    surfaceId: "s1",
    sourceComponentId: "save",
    timestamp: "2026-10-17T10:00:00.000Z",
    context: { name: "api", row: "r2", kind: "deploy", missing: null },
  })
  expect(surfaceActionEventSchema.safeParse(event).success).toBe(true)
})

test("the resolved context is a snapshot, detached from later edits", () => {
  const data = form()
  const event = surfaceActionEvent({ event: { name: "tag", context: { tags: { path: "/tags" } } } }, { surfaceId: "s1", sourceComponentId: "b", scope: [] }, data, new Date())
  data.write(["tags", "0"], "changed")
  expect(event.context).toEqual({ tags: ["a", "b"] })
})

test("a field bound to a path writes the data model; a literal value stays local to the field", () => {
  createRoot((dispose) => {
    const data = form()
    const bound = createBoundValue(() => ({ path: "/name" }), () => [], data, boundText)
    bound.set("web")
    expect([bound.value(), data.read(["name"])]).toEqual(["web", "web"])
    const literal = createBoundValue(() => "draft", () => [], data, boundText)
    literal.set("typed")
    expect([literal.value(), data.snapshot([])]).toEqual(["typed", { name: "web", tags: ["a", "b"], rows: [{ id: "r1" }, { id: "r2" }] }])
    dispose()
  })
})

test("a relative field binding inside a template writes that item's value", () => {
  createRoot((dispose) => {
    const data = form()
    const field = createBoundValue(() => ({ path: "id" }), () => itemScope(["rows"], 0), data, boundText)
    field.set("first")
    expect(data.snapshot(["rows"])).toEqual([{ id: "first" }, { id: "r2" }])
    dispose()
  })
})
