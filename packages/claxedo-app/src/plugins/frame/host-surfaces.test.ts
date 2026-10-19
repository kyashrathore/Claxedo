import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { PageDefinition, PluginApi, SurfaceMessage } from "@claxedo/plugin-api"
import { createHostPort } from "./host-port"
import { createSurfaceRoutes } from "./host-surfaces"
import { FrameProtocolError, type FrameMirror, type FrameToHost, type HostToFrame, type SurfaceDelivery } from "./protocol"

const deleted: SurfaceMessage = { version: "v0.9", deleteSurface: { surfaceId: "surface-1" } }

const MIRROR: FrameMirror = { locale: "en", projects: [], currentProjectId: undefined, currentSession: undefined, tabs: [], statuses: {} }

function recordingPort() {
  const posted: HostToFrame[] = []
  const port = { postMessage: (message: HostToFrame) => void posted.push(message), close: () => undefined, onmessage: null as ((event: MessageEvent<FrameToHost>) => void) | null }
  const receive = (message: FrameToHost) => port.onmessage?.({ data: message } as MessageEvent<FrameToHost>)
  return { port: port as unknown as MessagePort, posted, receive }
}

describe("surface routes on the host", () => {
  test("deliver to the attached surface only until it detaches, and report anything else", () => {
    const reported: FrameProtocolError[] = []
    const received: SurfaceMessage[] = []
    const routes = createSurfaceRoutes((error) => reported.push(error))
    const detach = routes.attach({ surfaceId: "surface-1", send: (...messages) => void received.push(...messages) })
    routes.deliver({ type: "surface", surfaceId: "surface-1", messages: [deleted] })
    routes.deliver({ type: "surface", surfaceId: "surface-2", messages: [deleted] })
    routes.deliver({ type: "surface", surfaceId: "surface-1", messages: "not a list" } as unknown as SurfaceDelivery)
    detach()
    routes.deliver({ type: "surface", surfaceId: "surface-1", messages: [deleted] })
    expect(received).toEqual([deleted])
    expect(reported).toHaveLength(3)
    expect(reported.every((error) => error instanceof FrameProtocolError)).toBe(true)
  })

  test("opening a frame surface page posts the current mirror before surface.open", () => {
    const { port, posted, receive } = recordingPort()
    const [projectId, setProjectId] = createSignal<string | undefined>("project-a")
    let page: PageDefinition | undefined
    const api = { pages: { register: (registered: PageDefinition) => ((page = registered), () => undefined) } } as unknown as PluginApi
    const failures: string[] = []
    createHostPort({ port, api, mirror: () => ({ ...MIRROR, currentProjectId: projectId() }), control: { slots: () => undefined, activated: () => undefined, failed: (reason) => failures.push(reason) } })
    receive({ type: "register", key: 1, registration: { kind: "page", id: "items", path: "/items", title: "Items", surface: true } })
    if (!page || !("surface" in page)) throw new Error("the host registered no surface page")
    const surfacePage = page
    setProjectId("project-b")
    createRoot(() => surfacePage.surface({ surfaceId: "surface-1", send: () => undefined }, { path: "/items", params: {} }))
    expect(posted.map((message) => message.type)).toEqual(["mirror", "invoke"])
    expect(posted[0]).toEqual({ type: "mirror", mirror: { ...MIRROR, currentProjectId: "project-b" } })
    expect(posted[1]).toMatchObject({ type: "invoke", invoke: { method: "surface.open", surfaceId: "surface-1", target: { kind: "page", pageId: "items" } } })
    expect(failures).toEqual([])
  })
})
