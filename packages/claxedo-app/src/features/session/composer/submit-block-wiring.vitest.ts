import { createRoot } from "solid-js"
import { afterEach, describe, expect, test, vi } from "vitest"

vi.mock("@/features/session/app-ports", () => ({
  useProviders: vi.fn(),
  workspacePlacement: () => undefined,
}))

import { createComposerSubmitBlockWiring } from "./submit-block-wiring"
import { submitHardBlocked } from "./submit-block-reason"

afterEach(() => {
  document.body.innerHTML = ""
})

type WiringInput = Partial<Parameters<typeof createComposerSubmitBlockWiring>[0]>

function wiring(root: HTMLElement, input: WiringInput = {}) {
  return createRoot(() =>
    createComposerSubmitBlockWiring({
      scope: () => "draft:one",
      isHarnessMode: () => true,
      harnessReadiness: () => "ready",
      harnessReadyForSubmit: () => false,
      harnessSelectionController: { read: () => ({}) } as never,
      toolbarState: {
        readiness: () => ({ label: "Select model" }),
        modelSubmitBlocked: () => false,
      } as never,
      providers: { loading: () => false } as never,
      booting: () => false,
      stoppable: () => false,
      blank: () => false,
      rootEl: () => root as HTMLDivElement,
      ...input,
    }),
  )
}

const hy3FreeToolbar = {
  readiness: () => ({ label: "HY3 Free", blocked: false, disabled: false }),
  modelSubmitBlocked: () => false,
} as never

function opencodeWiring(input: WiringInput = {}) {
  const root = document.createElement("div")
  return {
    root,
    ...wiring(root, {
      isHarnessMode: () => false,
      harnessReadyForSubmit: () => true,
      harnessSelectionController: {
        read: () => ({ draftDefaultState: "choose-model" }),
      } as never,
      toolbarState: hy3FreeToolbar,
      blank: () => false,
      ...input,
    }),
  }
}

function picker(action: string) {
  const trigger = document.createElement("button")
  trigger.dataset.action = action
  return trigger
}

describe("createComposerSubmitBlockWiring", () => {
  test("opens the harness model control for a harness no-model action", () => {
    const root = document.createElement("div")
    const trigger = picker("prompt-harness-model")
    const click = vi.spyOn(trigger, "click")
    root.append(trigger)

    wiring(root).openModelPicker()

    expect(click).toHaveBeenCalledOnce()
  })

  test("falls back to the OpenCode model control", () => {
    const root = document.createElement("div")
    const trigger = picker("prompt-model")
    const click = vi.spyOn(trigger, "click")
    root.append(trigger)

    wiring(root).openModelPicker()

    expect(click).toHaveBeenCalledOnce()
  })

  // The two controls are mutually exclusive today (the OpenCode model control
  // renders only outside harness mode), so this is a guard against the
  // preference silently inverting if that ever stops being true. A single
  // `querySelector('[a], [b]')` resolves by document order and would pick the
  // OpenCode control here.
  test("prefers the harness control even when the OpenCode control comes first in the DOM", () => {
    const root = document.createElement("div")
    const openCode = picker("prompt-model")
    const harness = picker("prompt-harness-model")
    const openCodeClick = vi.spyOn(openCode, "click")
    const harnessClick = vi.spyOn(harness, "click")
    root.append(openCode, harness)

    wiring(root).openModelPicker()

    expect(harnessClick).toHaveBeenCalledOnce()
    expect(openCodeClick).not.toHaveBeenCalled()
  })

  describe("stale draft-default choose-model regression", () => {
    // Regression: HY3 Free (or any explicit pick) showed in the picker while
    // harness-store draftDefaultState stayed "choose-model". needsModelSelection
    // used to hard-block Send and reopen the picker even though the toolbar
    // had already resolved a submittable model.
    test("does not no-model block once the toolbar resolves HY3 Free", () => {
      const { submitBlock, submitInertBlocked } = opencodeWiring()

      expect(submitBlock()).toBeNull()
      expect(submitInertBlocked()).toBe(false)
      expect(submitHardBlocked({ stoppable: false, block: submitBlock() })).toBe(false)
    })

    test("still no-model blocks when draft-default choose-model and toolbar is unresolved", () => {
      const { submitBlock } = opencodeWiring({
        toolbarState: {
          readiness: () => ({ label: "Select model", blocked: true, disabled: true }),
          modelSubmitBlocked: () => true,
        } as never,
      })

      expect(submitBlock()?.reason).toBe("no-model")
      expect(submitHardBlocked({ stoppable: false, block: submitBlock() })).toBe(true)
    })

    test("saved-model-unavailable draft state does not block after a new explicit pick", () => {
      const { submitBlock } = opencodeWiring({
        harnessSelectionController: {
          read: () => ({
            draftDefaultState: "saved-model-unavailable",
            draftDefaultModel: { providerID: "opencode", modelID: "north-mini-code-free" },
          }),
        } as never,
      })

      expect(submitBlock()).toBeNull()
    })
  })
})
