import { describe, expect, test } from "bun:test"
import { parseShellRoute, workGraphRoute } from "@/platform/identity/route"
import { surfaceRoute } from "@/app/workbench/state/surface-route"

describe("WorkGraph app integration", () => {
  test("restores the single WorkGraph home route — streams expand in place, no detail route", () => {
    expect(parseShellRoute(workGraphRoute())).toEqual({ kind: "workgraph" })
    expect(surfaceRoute("", { type: "workgraph", content: { type: "workgraph" } })).toBe("/workgraph")
    // There is no per-stream detail route; a stream path no longer resolves to WorkGraph.
    expect(parseShellRoute("/workgraph/streams/stream_1")).not.toMatchObject({ kind: "workgraph" })
  })

})
