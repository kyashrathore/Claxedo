import { describe, expect, test } from "bun:test"
import type { SurfaceMessage } from "@claxedo/plugin-api"
import { createSurfaceRoutes } from "./host-surfaces"
import { FrameProtocolError, type SurfaceDelivery } from "./protocol"

const deleted: SurfaceMessage = { version: "v0.9", deleteSurface: { surfaceId: "surface-1" } }

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
})
