import { describe, expect, test } from "bun:test"
import type { PageDefinition, PagesApi, SurfaceChannel, SurfaceMessage, SurfacePageDefinition } from "./index"
import { SURFACE_CATALOG_ID, surfaceMessageSchema } from "./surface"

function counterPage(): SurfacePageDefinition {
  return {
    id: "counter",
    path: "/counter",
    title: "Counter",
    surface: (channel) => {
      let count = 0
      const { surfaceId } = channel
      channel.send(
        { version: "v0.9", createSurface: { surfaceId, catalogId: SURFACE_CATALOG_ID } },
        {
          version: "v0.9",
          updateComponents: {
            surfaceId,
            components: [
              { id: "root", component: "Column", children: ["count", "add"] },
              { id: "count", component: "Text", text: { path: "/count" } },
              { id: "add", component: "Button", child: "add-label", action: { event: { name: "add" } } },
              { id: "add-label", component: "Text", text: "Add" },
            ],
          },
        },
        { version: "v0.9", updateDataModel: { surfaceId, path: "/count", value: count } },
      )
      return {
        action: (action) => {
          if (action.name !== "add") return
          count += 1
          channel.send({ version: "v0.9", updateDataModel: { surfaceId, path: "/count", value: count } })
        },
      }
    },
  }
}

function recordingChannel(surfaceId: string): SurfaceChannel & { readonly sent: SurfaceMessage[] } {
  const sent: SurfaceMessage[] = []
  return { surfaceId, sent, send: (...messages) => void sent.push(...messages) }
}

describe("SurfacePageDefinition", () => {
  test("is a page the pages api registers", () => {
    const registered: PageDefinition[] = []
    const pages: Pick<PagesApi, "register"> = { register: (page) => (registered.push(page), () => undefined) }
    pages.register(counterPage())
    expect(registered.map((page) => ("surface" in page ? "surface" : "render"))).toEqual(["surface"])
  })

  test("sends A2UI messages addressed to the host's surface id and answers actions", async () => {
    const channel = recordingChannel("page-1")
    const program = counterPage().surface(channel, { path: "/counter", params: {} })
    await program?.action?.({ name: "add", surfaceId: "page-1", sourceComponentId: "add", timestamp: "2026-10-17T00:00:00Z", context: {} })
    expect(channel.sent.every((message) => surfaceMessageSchema.safeParse(message).success)).toBe(true)
    expect(channel.sent.at(-1)).toEqual({ version: "v0.9", updateDataModel: { surfaceId: "page-1", path: "/count", value: 1 } })
  })

  test("types refuse a message outside the protocol", () => {
    const channel = recordingChannel("page-2")
    // @ts-expect-error
    channel.send({ version: "v0.9", createSurface: { surfaceId: "page-2", catalogId: "https://example.com/catalog.json" } })
    // @ts-expect-error
    const page: PageDefinition = { id: "empty", path: "/empty", title: "Empty" }
    expect(page.id).toBe("empty")
  })
})
