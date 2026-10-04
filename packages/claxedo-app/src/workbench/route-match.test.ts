/// <reference types="bun" />
import { expect, test } from "bun:test"
import type { PaneRoute } from "@/shell"
import { samePaneRoute } from "./route-match"

const draft = (placementId: string) => ({ kind: "draft", projectId: "prj_1", placementId }) as PaneRoute

test("a pane shows a route when every field matches, whatever their order, so reopening a draft's route finds that draft", () => {
  expect(samePaneRoute(draft("ws_a"), { placementId: "ws_a", kind: "draft", projectId: "prj_1" } as PaneRoute)).toBe(true)
  expect(samePaneRoute(draft("ws_a"), draft("ws_b"))).toBe(false)
  expect(samePaneRoute(undefined, draft("ws_a"))).toBe(false)
})
