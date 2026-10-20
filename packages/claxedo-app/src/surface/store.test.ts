/// <reference types="bun" />
import { describe, expect, test } from "bun:test"
import { createEffect, createRoot } from "solid-js"
import { SURFACE_CATALOG_ID, type SurfaceComponent, type SurfaceMessage } from "@claxedo/plugin-api/surface"
import { createSurface } from "./store"
import { SurfaceMessageError, surfaceState } from "./model"

const version = "v0.9" as const

function created(surfaceId = "s1") {
  const surface = createSurface(surfaceId)
  surface.apply({ version, createSurface: { surfaceId, catalogId: SURFACE_CATALOG_ID } })
  return surface
}

function components(surfaceId: string, list: SurfaceComponent[]): SurfaceMessage {
  return { version, updateComponents: { surfaceId, components: list } }
}

describe("apply", () => {
  test("refuses a message addressed to another surface and changes nothing", () => {
    const surface = created("s1")
    expect(() => surface.apply(components("s2", [{ id: "root", component: "Text", text: "Hi" }]))).toThrow(SurfaceMessageError)
    expect(surface[surfaceState].components.get("root")).toBeUndefined()
  })

  test("refuses a malformed message", () => {
    const surface = created("s1")
    const malformed = { version, updateComponents: { surfaceId: "s1", components: [{ id: "root", component: "Modal" }] } }
    expect(() => surface.apply(malformed as unknown as SurfaceMessage)).toThrow(SurfaceMessageError)
  })

  test("names the deepest path inside the message where it broke", () => {
    const surface = created("s1")
    const missingText = { version, updateComponents: { surfaceId: "s1", components: [{ id: "root", component: "Column", children: [] }, { id: "t", component: "Text" }] } }
    expect(() => surface.apply(missingText as unknown as SurfaceMessage)).toThrow(/at \/updateComponents\/components\/1\/text: /)
  })

})

describe("apply across the lifecycle", () => {
  test("refuses updates before the surface is created, and a second create", () => {
    const surface = createSurface("s1")
    expect(() => surface.apply({ version, updateDataModel: { surfaceId: "s1", value: {} } })).toThrow(SurfaceMessageError)
    surface.apply({ version, createSurface: { surfaceId: "s1", catalogId: SURFACE_CATALOG_ID } })
    expect(surface[surfaceState].lifecycle()).toEqual({ kind: "live" })
    expect(() => surface.apply({ version, createSurface: { surfaceId: "s1", catalogId: SURFACE_CATALOG_ID } })).toThrow(SurfaceMessageError)
  })

  test("a data update with no path replaces the whole model", () => {
    const surface = created()
    surface.apply({ version, updateDataModel: { surfaceId: "s1", value: { name: "api" } } })
    surface.apply({ version, updateDataModel: { surfaceId: "s1", path: "/regions/0", value: "eu" } })
    expect(surface[surfaceState].data.snapshot([])).toEqual({ name: "api", regions: { "0": "eu" } })
  })

  test("deleteSurface clears components and data, and the surface can be created again", () => {
    const surface = created()
    surface.apply(components("s1", [{ id: "root", component: "Text", text: "Hi" }]))
    surface.apply({ version, updateDataModel: { surfaceId: "s1", value: { a: 1 } } })
    surface.apply({ version, deleteSurface: { surfaceId: "s1" } })
    const state = surface[surfaceState]
    expect([state.lifecycle().kind, state.components.get("root"), state.data.snapshot([])]).toEqual(["deleted", undefined, {}])
    expect(() => surface.apply(components("s1", []))).toThrow(SurfaceMessageError)
    surface.apply({ version, createSurface: { surfaceId: "s1", catalogId: SURFACE_CATALOG_ID } })
    expect(state.lifecycle().kind).toBe("live")
  })
})

describe("updateComponents", () => {
  test("upserts by id: an untouched component keeps its definition and does not re-run", () => {
    const surface = created()
    surface.apply(components("s1", [
      { id: "root", component: "Column", children: ["title", "body"] },
      { id: "title", component: "Text", text: "Old", variant: "h2" },
      { id: "body", component: "Text", text: "Body" },
    ]))
    const registry = surface[surfaceState].components
    const before = { title: registry.get("title"), body: registry.get("body") }
    const runs = { title: 0, body: 0, variant: 0 }
    const dispose = createRoot((dispose) => {
      createEffect(() => {
        void (registry.get("title") as { text: unknown }).text
        runs.title += 1
      })
      createEffect(() => {
        void (registry.get("title") as { variant: unknown }).variant
        runs.variant += 1
      })
      createEffect(() => {
        void (registry.get("body") as { text: unknown }).text
        runs.body += 1
      })
      return dispose
    })
    surface.apply(components("s1", [{ id: "title", component: "Text", text: "New", variant: "h2" }]))
    expect(registry.get("title")).toBe(before.title)
    expect(registry.get("body")).toBe(before.body)
    expect(runs).toEqual({ title: 2, body: 1, variant: 1 })
    dispose()
  })

  test("replaces a component's definition, dropping props the new one leaves out", () => {
    const surface = created()
    surface.apply(components("s1", [{ id: "root", component: "Text", text: "Hi", variant: "h1" }]))
    surface.apply(components("s1", [{ id: "root", component: "Badge", text: "New" }]))
    expect(surface[surfaceState].components.get("root")).toEqual({ id: "root", component: "Badge", text: "New" })
  })
})
