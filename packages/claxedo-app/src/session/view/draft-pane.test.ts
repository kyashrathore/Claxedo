/// <reference types="bun" />
import { expect, test } from "bun:test"
import { placementId, projectId } from "@/server"
import type { PaneRoute } from "@/shell"
import { draftPaneContract, draftWhere, newDraft, type DraftSessionState } from "./draft-state"

const project = projectId("prj_1")
const started = placementId("ws_started")
const chosen = placementId("ws_chosen")

function routeOf(state: DraftSessionState): PaneRoute | undefined {
  return draftPaneContract.toRoute?.(state)
}

test("a draft's target and route are the Where it chose, so the URL names the workspace a first message runs in", () => {
  const moved = { ...newDraft({ projectId: project, placementId: started }), where: chosen }
  expect(draftWhere(moved)).toBe(chosen)
  expect(routeOf(moved)).toEqual({ kind: "draft", projectId: project, placementId: chosen })
  const fresh = newDraft({ projectId: project, placementId: started })
  expect(draftWhere(fresh)).toBe(started)
  expect(routeOf(fresh)).toEqual({ kind: "draft", projectId: project, placementId: started })
})

test("a session URL that names a workspace is not the route of a draft that moved its Where elsewhere, so it opens its own draft there", () => {
  const moved = { ...newDraft({ projectId: project, placementId: started }), where: chosen }
  const named: PaneRoute = { kind: "draft", projectId: project, placementId: started }
  expect(routeOf(moved)).not.toEqual(named)
  const opened = draftPaneContract.fromRoute?.(named) as DraftSessionState
  expect(draftWhere(opened)).toBe(started)
  expect(opened.where).toBeUndefined()
  expect(routeOf(opened)).toEqual(named)
})

test("the pane state round-trips its chosen Where", () => {
  const moved = { ...newDraft({ projectId: project, placementId: started }), where: chosen }
  expect(draftPaneContract.decode(draftPaneContract.encode(moved))).toEqual(moved)
})
