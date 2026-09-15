import { cleanup, fireEvent, render } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import { createSignal, type Accessor } from "solid-js"
import type { SubmitBlock } from "@/features/session/composer/submit-block-reason"

vi.mock("@opencode-ai/ui/tooltip", () => ({
  Tooltip: (props: { children: unknown }) => <>{props.children}</>,
}))

import { PromptSubmitControl } from "./submit-control"
import { DockShellForm } from "@opencode-ai/ui/dock-surface"

afterEach(cleanup)

const block = (reason: SubmitBlock["reason"], copy: string): SubmitBlock => ({
  reason,
  copy,
  actionable: true,
})

function renderControl(input: {
  block?: SubmitBlock | null
  booting?: boolean | Accessor<boolean>
  onChooseModel?: () => void
  busy?: boolean
  blank?: boolean
}) {
  const submit = vi.fn((event: SubmitEvent) => event.preventDefault())
  const view = render(() => (
    <DockShellForm onSubmit={submit}>
      <PromptSubmitControl
        stage={() => undefined}
        busy={() => input.busy ?? false}
        onCancel={() => {}}
        onRetry={() => undefined}
        booting={() => typeof input.booting === "function" ? input.booting() : input.booting ?? false}
        working={() => false}
        blank={() => input.blank ?? false}
        tip={() => "Send"}
        bootText={() => "Starting"}
        mode={() => "normal"}
        disabled={() => false}
        excludeFromTab={() => false}
        block={() => input.block ?? null}
        onChooseModel={input.onChooseModel ?? (() => {})}
        readOnlyBlocked={() => false}
        sendLabel="Send"
        stopLabel="Stop"
        readOnlyLabel="Read-only"
      />
    </DockShellForm>
  ))
  return { ...view, submit }
}

describe("PromptSubmitControl", () => {
  test("reads Stop only while there is nothing to send", () => {
    expect(renderControl({ busy: true, blank: true }).getByRole("button", { name: "Stop" })).toBeTruthy()
  })

  test("offers Send for a draft written while a turn is running", () => {
    const view = renderControl({ busy: true, blank: false })

    expect(view.getByRole("button", { name: "Send" })).toBeTruthy()
    expect(view.queryByRole("button", { name: "Stop" })).toBeNull()
  })

  test("submits the real control through the shared dock form", () => {
    const view = renderControl({})

    fireEvent.click(view.getByRole("button", { name: "Send" }))

    expect(view.submit).toHaveBeenCalledOnce()
  })

  test("opens the model picker directly when the missing-model block is actionable", () => {
    const onChooseModel = vi.fn()
    const view = renderControl({
      block: block("no-model", "Choose a model to continue"),
      onChooseModel,
    })

    fireEvent.click(view.getByRole("button", { name: "Choose a model to continue" }))

    expect(onChooseModel).toHaveBeenCalledOnce()
    expect(view.submit).not.toHaveBeenCalled()
  })

  // The filled circle carries its own inverse foreground; the glyph must not be
  // repainted with the shell icon color. This asserts only what this component
  // owns — the variant and the inverse class. The matching guard against a
  // `data-icon-interaction="persistent"` hover rule overriding it lives in
  // `app/styles/ui-overrides.css`, not here.
  test("renders the submit glyph inside an inverse primary action", () => {
    const view = renderControl({})
    const submit = view.getByRole("button", { name: "Send" })

    expect(submit).toHaveAttribute("data-variant", "primary")
    expect(submit.className).toContain("text-v2-icon-icon-inverse")
    expect(submit.querySelector('[data-icon="send"] use')).toHaveAttribute("href", "#claxedo-icon-send")
  })

  // Booting lives inside the send button, not as a chip beside it: the spinner
  // overlays the circle, the arrow fades out underneath, and the words move to
  // the accessible name. No standalone booting text may render in the toolbar.
  test("booting is the send button spinning, not a chip beside it", () => {
    const view = renderControl({ booting: true })
    const submit = view.getByRole("button", { name: "Starting" })

    expect(submit).toHaveAttribute("data-booting")
    expect(submit.parentElement?.querySelector('[data-component="spinner"], svg.animate-spin, [class*="animate"]')).toBeTruthy()
    expect(view.queryByText("Starting")).toBeNull()
  })

  test("the spinner leaves and the arrow returns once boot completes", () => {
    const [booting, setBooting] = createSignal(true)
    const view = renderControl({ booting })
    const submit = view.getByRole("button", { name: "Starting" })
    const spinner = () => submit.parentElement?.querySelector('[data-component="spinner"], svg.animate-spin, [class*="animate"]')
    expect(spinner()).toBeTruthy()

    setBooting(false)

    expect(view.getByRole("button", { name: "Send" })).toBe(submit)
    expect(submit).not.toHaveAttribute("data-booting")
    expect(spinner()).toBeNull()
    expect(submit.querySelector('[data-icon="send"] use')).toHaveAttribute("href", "#claxedo-icon-send")
  })
})
