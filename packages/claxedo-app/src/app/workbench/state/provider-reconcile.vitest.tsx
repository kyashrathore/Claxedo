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
import { createEffect, createRoot } from "solid-js"
import type { JSX } from "@solidjs/web"
import { ClaxedoStateProvider, useClaxedoState, type ClaxedoStateApi } from "./provider"
import { emptyClaxedoState } from "./persistence"
import { Workbench } from "../workbench/index"

afterEach(() => {
  cleanup()
  localStorage.clear()
})

function SessionProbe(props: { id: string }) {
  const state = useClaxedoState()
  const meta = () => state.meta.get(props.id)
  return (
    <div data-testid={`content-${props.id}`} data-session-id={meta()?.sessionId}>
      content {props.id}
    </div>
  )
}

function mountThroughProvider(opts?: { productionMountPolicy?: boolean }) {
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
        renderContent={(id) => <SessionProbe id={id} />}
        renderEmpty={() => <div data-testid="empty">empty</div>}
        mountPolicy={opts?.productionMountPolicy ? "visible-once" : undefined}
        maxMountedContents={opts?.productionMountPolicy ? 24 : undefined}
        mountCapCandidate={opts?.productionMountPolicy ? (id) => api.meta.get(id)?.type === "session" : undefined}
        retainedHiddenLimit={opts?.productionMountPolicy ? () => 24 : undefined}
      />
    </ClaxedoStateProvider>
  ))
  return { utils, api: () => api }
}

describe("ClaxedoStateProvider workbench reconcile (production wiring)", () => {
  test("opening a real session replaces the visible draft under the production mount policy", async () => {
    const { utils, api } = mountThroughProvider({ productionMountPolicy: true })

    const draftContentId = api().layout.openSession("/work/foo", "new", "New Session")
    await Promise.resolve()
    expect(
      utils.container
        .querySelector('[data-session-id="new"]')
        ?.closest("[data-workbench-content]")
        ?.getAttribute("data-workbench-content"),
    ).toBe(draftContentId)

    const sessionContentId = api().layout.openSession("/work/foo", "ses_real", "Real Session")
    await Promise.resolve()

    // Absence of `aria-hidden` is the workbench's canonical exposed state — it
    // deliberately never installs a redundant `aria-hidden="false"` on a cold
    // mount — so the visible slot is the one WITHOUT the attribute, and under a
    // single-pane layout it must be the only one.
    const visible = utils.container.querySelectorAll("[data-workbench-content]:not([aria-hidden])")
    expect(visible).toHaveLength(1)
    expect(visible[0]!.getAttribute("data-workbench-content")).toBe(sessionContentId)
    expect(visible[0]!.querySelector('[data-session-id="ses_real"]')).toBeTruthy()
    // The draft slot is retained by the mount policy, but explicitly hidden and
    // inert — not merely un-exposed. (jsdom has no `HTMLElement.inert`, so the
    // attribute Solid 2 writes for `inert={true}` is the observable form.)
    const draftSlot = utils.container.querySelector(`[data-workbench-content="${draftContentId}"]`)
    expect(draftSlot?.getAttribute("aria-hidden")).toBe("true")
    expect(draftSlot?.hasAttribute("inert")).toBe(true)
  })

  test("content added after mount is projected into the Workbench DOM", async () => {
    const { utils, api } = mountThroughProvider()

    api().wb.contents.add("late-session")
    api().wb.navigation.show("late-session")
    await Promise.resolve()

    expect(utils.getByTestId("content-late-session")).toBeTruthy()
    expect(utils.container.querySelector('[data-workbench-content="late-session"]')).toBeTruthy()
  })

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

  test("one session focus wakes only the changed pane and recency slices", async () => {
    const { api } = mountThroughProvider()
    api().wb.contents.add("a")
    api().wb.contents.add("b")
    api().wb.navigation.show("a")
    await Promise.resolve()

    const runs = {
      paneContent: 0,
      recency: 0,
      contentIds: 0,
      split: 0,
      snapshots: 0,
    }
    let dispose = () => {}
    createRoot((rootDispose) => {
      dispose = rootDispose
      // Two-phase: the COMPUTE holds the tracked read of one workbench slice,
      // the effect phase counts the wakes. Each compute returns a primitive (or
      // the unchanged store node) so a re-run that produces the same value does
      // not count as a wake — which is exactly the claim under test.
      createEffect(
        () => api().wb.state.panes[0]?.contentId,
        () => {
          runs.paneContent += 1
        },
      )
      createEffect(
        () => api().wb.state.contentRecency.join("|"),
        () => {
          runs.recency += 1
        },
      )
      createEffect(
        () => api().wb.state.contentIds.join("|"),
        () => {
          runs.contentIds += 1
        },
      )
      createEffect(
        () => api().wb.state.split.root,
        () => {
          runs.split += 1
        },
      )
      createEffect(
        () => Object.keys(api().wb.state.layoutSnapshots).length,
        () => {
          runs.snapshots += 1
        },
      )
    })
    await Promise.resolve()
    expect(runs).toEqual({ paneContent: 1, recency: 1, contentIds: 1, split: 1, snapshots: 1 })

    api().wb.navigation.show("b")
    await Promise.resolve()

    // The focus operation has two canonical writes. The content-id registry,
    // split geometry, and saved layouts are unrelated and must stay asleep.
    expect(runs).toEqual({ paneContent: 2, recency: 2, contentIds: 1, split: 1, snapshots: 1 })
    dispose()
  })

  test("session recency moves as one atomic collection instead of rewriting every index", async () => {
    const { api } = mountThroughProvider()
    for (let index = 0; index < 200; index += 1) {
      api().wb.contents.add(`session-${index}`)
    }
    api().wb.navigation.show("session-0")
    await Promise.resolve()

    const before = api().wb.state.contentRecency
    api().wb.navigation.show("session-199")
    await Promise.resolve()

    const after = api().wb.state.contentRecency
    // Replacing the collection property is the bounded Solid-store write.
    // Reconciling the array in place would preserve this proxy while emitting
    // one signal for each of the 199 shifted indexes.
    expect(after).not.toBe(before)
    expect(after[0]).toBe("session-199")
    expect(after).toHaveLength(200)
    expect(new Set(after).size).toBe(200)
  })
})
