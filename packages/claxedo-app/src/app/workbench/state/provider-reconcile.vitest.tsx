// Production-wiring regression test for the ClaxedoStateProvider → Workbench
// path. The workbench's own suites (workbench/tests/*) mount through
// `dom-helpers.tsx`, which applies reducer output with `reconcile` — so they
// could never see the production defect this pins: `wbOnChange` used a plain
// `setState("workbench", next)`, and because every reducer returns brand-new
// `panes`/`split` references, EVERY `navigation.show` replaced those store
// nodes wholesale. The pane-chrome `<For each={panes}>` keys rows by pane
// OBJECT identity, so each switch tore down and recreated every pane div (and
// its handle/close zones) — a full DOM rebuild plus page relayout per click,
// and an invalidation of every `focusedContent()` subscriber in the app.
//
// The contract under test: driving the REAL provider (store + persistence
// wrapper + reconcile), a `navigation.show` that reuses the single pane must
// keep the pane's DOM node identity, and must keep the untouched parts of the
// workbench store referentially stable.

import { describe, expect, test, afterEach } from "vitest"
import { cleanup, render } from "@solidjs/testing-library"
import type { JSX } from "solid-js"
import { ClaxedoStateProvider, useClaxedoState, type ClaxedoStateApi } from "./provider"
import { emptyClaxedoState } from "./persistence"
import { Workbench } from "../workbench/index"

afterEach(() => {
  cleanup()
  localStorage.clear()
})

function mountThroughProvider() {
  let api!: ClaxedoStateApi
  const Capture = () => {
    api = useClaxedoState()
    // as-any: capture-only test component intentionally renders no DOM.
    return null as unknown as JSX.Element
  }
  const utils = render(() => (
    <ClaxedoStateProvider initialState={emptyClaxedoState()}>
      <Capture />
      <Workbench
        renderContent={(id) => <div data-testid={`content-${id}`}>content {id}</div>}
        renderEmpty={() => <div data-testid="empty">empty</div>}
      />
    </ClaxedoStateProvider>
  ))
  return { utils, api: () => api }
}

describe("ClaxedoStateProvider workbench reconcile (production wiring)", () => {
  test("navigation.show between contents keeps the pane's DOM node", async () => {
    const { utils, api } = mountThroughProvider()
    api().wb.contents.add("a")
    api().wb.contents.add("b")
    api().wb.navigation.show("a")
    await Promise.resolve()

    const paneId = api().wb.state.panes[0]!.id
    const paneBefore = utils.container.querySelector(`[data-testid="pane-${paneId}"]`)
    expect(paneBefore).toBeTruthy()

    api().wb.navigation.show("b")
    await Promise.resolve()

    // Same single-pane layout: the reducer reuses the pane id, so reconcile
    // must update `contentId` in place instead of replacing the pane object —
    // pinned here through the DOM, which <For> rebuilds when identity breaks.
    expect(api().wb.state.panes[0]!.id).toBe(paneId)
    const paneAfter = utils.container.querySelector(`[data-testid="pane-${paneId}"]`)
    expect(paneAfter).toBeTruthy()
    expect(paneAfter!.isSameNode(paneBefore)).toBe(true)
  })

  test("navigation.show leaves untouched store nodes referentially stable", async () => {
    const { api } = mountThroughProvider()
    api().wb.contents.add("a")
    api().wb.contents.add("b")
    api().wb.navigation.show("a")
    await Promise.resolve()

    const before = api().wb.state
    const panesBefore = before.panes
    const paneBefore = before.panes[0]!
    const contentIdsBefore = before.contentIds

    api().wb.navigation.show("b")
    await Promise.resolve()

    const after = api().wb.state
    // contentIds is untouched by show(); the store must keep the same node.
    expect(after.contentIds).toBe(contentIdsBefore)
    // The pane set has the same single pane id: same array node, same pane
    // node, only `contentId` rewritten.
    expect(after.panes).toBe(panesBefore)
    expect(after.panes[0]).toBe(paneBefore)
    expect(after.panes[0]!.contentId).toBe("b")
  })
})
