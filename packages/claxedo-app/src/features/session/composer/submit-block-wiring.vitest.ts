import { createRoot } from "solid-js"
import { afterEach, describe, expect, test, vi } from "vitest"

vi.mock("@/features/session/app-ports", () => ({
  useProviders: vi.fn(),
  workspacePlacement: () => undefined,
}))

import { createComposerSubmitBlockWiring } from "./submit-block-wiring"

afterEach(() => {
  document.body.innerHTML = ""
})

function wiring(root: HTMLElement) {
  return createRoot(() =>
    createComposerSubmitBlockWiring({
      scope: () => "draft",
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
    }),
  )
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
})
