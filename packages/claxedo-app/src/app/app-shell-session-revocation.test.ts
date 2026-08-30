import { describe, expect, test } from "bun:test"
import type { ContentMeta } from "./workbench/state"
import { applySessionAccessRevocation } from "./app-shell-route-sync"

function surface(input: Partial<ContentMeta> & Pick<ContentMeta, "id" | "type">): ContentMeta {
  return input as ContentMeta
}

describe("applySessionAccessRevocation", () => {
  test("closes every matching session surface and redirects an active deep link", () => {
    const closed: string[] = []
    const navigated: Array<[string, { replace: boolean }]> = []
    const surfaces = [
      surface({ id: "content-main", type: "session", sessionId: "ses_revoked", directory: "/repo" }),
      surface({ id: "content-context", type: "context", sessionId: "ses_revoked", directory: "/repo" }),
      surface({ id: "content-keep", type: "session", sessionId: "ses_keep", directory: "/repo" }),
    ]

    applySessionAccessRevocation({
      sessionId: "ses_revoked",
      workspaceId: "ws_1",
      activeSurfaceId: () => "content-main",
      surfaces: () => surfaces,
      closeContent: (id) => closed.push(id),
      navigate: (to, options) => navigated.push([to, options]),
    })

    expect(closed).toEqual(["content-main", "content-context"])
    expect(navigated).toEqual([["/w/ws_1", { replace: true }]])
  })

  test("leaves routing unchanged when only a retained background surface is revoked", () => {
    const closed: string[] = []
    const navigated: string[] = []

    applySessionAccessRevocation({
      sessionId: "ses_revoked",
      workspaceId: "ws_1",
      activeSurfaceId: () => "content-keep",
      surfaces: () => [
        surface({ id: "content-revoked", type: "session", sessionId: "ses_revoked" }),
        surface({ id: "content-keep", type: "session", sessionId: "ses_keep" }),
      ],
      closeContent: (id) => closed.push(id),
      navigate: (to) => navigated.push(to),
    })

    expect(closed).toEqual(["content-revoked"])
    expect(navigated).toEqual([])
  })
})
