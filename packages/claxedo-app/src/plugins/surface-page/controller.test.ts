import { describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import type { SurfaceActionEvent, SurfaceMessage, SurfacePageDefinition, SurfaceProgram } from "@claxedo/plugin-api"
import { SURFACE_CATALOG_ID } from "@claxedo/plugin-api/surface"
import { openSurfacePage } from "./controller"

await mock.module("@/surface/view/surface-view", () => ({ SurfaceView: () => undefined }))
const { createSurface, SurfaceMessageError } = await import("@/surface")

const SURFACE_ID = "surface-1"

const created: SurfaceMessage = { version: "v0.9", createSurface: { surfaceId: SURFACE_ID, catalogId: SURFACE_CATALOG_ID } }
const counted = (count: number): SurfaceMessage => ({ version: "v0.9", updateDataModel: { surfaceId: SURFACE_ID, path: "/count", value: count } })
const tapped: SurfaceActionEvent = { name: "add", surfaceId: SURFACE_ID, sourceComponentId: "add", timestamp: "2026-10-17T00:00:00Z", context: {} }

function recordingSurface() {
  const applied: SurfaceMessage[] = []
  const drawn = createSurface(SURFACE_ID)
  const apply = (message: SurfaceMessage) => {
    drawn.apply(message)
    applied.push(message)
  }
  return { applied, surface: { surfaceId: SURFACE_ID, apply } }
}

function surfacePage(surface: SurfacePageDefinition["surface"]): SurfacePageDefinition {
  return { id: "counter", path: "/counter", title: "Counter", surface }
}

function open(page: SurfacePageDefinition, surface = recordingSurface().surface) {
  return createRoot((dispose) => ({ controller: openSurfacePage({ surface, page, props: { path: "/counter", params: { team: "core" } } }), dispose }))
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe("a plugin surface page's messages", () => {
  test("hands the plugin the host's surface id and applies what it sends, in order", () => {
    const { applied, surface } = recordingSurface()
    const seen: string[] = []
    const { controller } = open(
      surfacePage((channel, props) => {
        seen.push(channel.surfaceId, props.params.team ?? "")
        channel.send(created, counted(0))
        channel.send(counted(1))
      }),
      surface,
    )
    expect(seen).toEqual([SURFACE_ID, "core"])
    expect(applied).toEqual([created, counted(0), counted(1)])
    expect(controller.state()).toEqual({ kind: "open" })
  })

  test("drops a message outside A2UI v0.9 and every later one, and fails", () => {
    const { applied, surface } = recordingSurface()
    const invalid = { version: "v0.9", updateComponents: { surfaceId: SURFACE_ID, components: [{ id: "root", component: "Modal" }] } }
    const { controller } = open(surfacePage((channel) => channel.send(created, invalid as unknown as SurfaceMessage, counted(2))), surface)
    expect(applied).toEqual([created])
    const state = controller.state()
    if (state.kind !== "failed") throw new Error(`expected failed, got ${state.kind}`)
    expect(state.error).toBeInstanceOf(SurfaceMessageError)
  })

  test("fails when the renderer refuses a message or the plugin throws while opening", () => {
    const refusing = { surfaceId: SURFACE_ID, apply: () => { throw new Error("another surface") } }
    expect(open(surfacePage((channel) => channel.send(created)), refusing).controller.state()).toMatchObject({ kind: "failed", error: { message: "another surface" } })
    const throwing = open(surfacePage(() => { throw new Error("no data") })).controller
    expect(throwing.state()).toMatchObject({ kind: "failed", error: { message: "no data" } })
  })

})

describe("a plugin surface page's actions", () => {
  test("routes an action to the program, and fails when it rejects", async () => {
    const { applied, surface } = recordingSurface()
    const actions: string[] = []
    const program: SurfaceProgram = {
      action: async (action) => {
        actions.push(action.name)
        if (actions.length > 1) throw new Error("save failed")
      },
    }
    const { controller } = open(surfacePage(() => program), surface)
    controller.action(tapped)
    await settle()
    expect(controller.state().kind).toBe("open")
    controller.action(tapped)
    await settle()
    expect(controller.state()).toMatchObject({ kind: "failed", error: { message: "save failed" } })
    controller.action(tapped)
    expect(actions).toEqual(["add", "add"])
    expect(applied).toEqual([])
  })

})

describe("closing a plugin surface page", () => {
  test("disposes the program once on close and ignores what it sends afterwards", () => {
    const { applied, surface } = recordingSurface()
    let disposed = 0
    let send: (message: SurfaceMessage) => void = () => undefined
    const { controller } = open(
      surfacePage((channel) => {
        send = (message) => channel.send(message)
        return { dispose: () => void disposed++ }
      }),
      surface,
    )
    controller.close()
    controller.close()
    send(counted(3))
    controller.action(tapped)
    expect(disposed).toBe(1)
    expect(applied).toEqual([])
    expect(controller.state()).toEqual({ kind: "closed" })
  })
})
