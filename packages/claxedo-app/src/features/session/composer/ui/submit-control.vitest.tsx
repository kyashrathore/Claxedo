import { cleanup, fireEvent, render } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
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
  booting?: boolean
  onChooseModel?: () => void
  onConnectAI?: () => void
}) {
  const submit = vi.fn((event: SubmitEvent) => event.preventDefault())
  const view = render(() => (
    <form onSubmit={submit}>
      <PromptSubmitControl
        stage={() => undefined}
        busy={() => false}
        onCancel={() => {}}
        onRetry={() => undefined}
        booting={() => input.booting ?? false}
        working={() => false}
        blank={() => false}
        tip={() => "Send"}
        bootText={() => "Starting"}
        mode={() => "normal"}
        disabled={() => false}
        excludeFromTab={() => false}
        block={() => input.block ?? null}
        onConnectAI={input.onConnectAI ?? (() => {})}
        onChooseModel={input.onChooseModel ?? (() => {})}
        readOnlyBlocked={() => false}
        sendLabel="Send"
        stopLabel="Stop"
        readOnlyLabel="Read-only"
      />
    </form>
  ))
  return { ...view, submit }
}

describe("PromptSubmitControl", () => {
  test("submits through the shared dock form", () => {
    const submit = vi.fn((event: SubmitEvent) => event.preventDefault())
    const view = render(() => (
      <DockShellForm onSubmit={submit}>
        <button type="submit">Send through dock</button>
      </DockShellForm>
    ))

    fireEvent.click(view.getByRole("button", { name: "Send through dock" }))

    expect(submit).toHaveBeenCalledOnce()
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

  test("opens provider connection directly when the missing-credential block is actionable", () => {
    const onConnectAI = vi.fn()
    const view = renderControl({
      block: block("no-credential", "Connect an AI provider to continue"),
      onConnectAI,
    })

    fireEvent.click(view.getByRole("button", { name: "Connect an AI provider to continue" }))

    expect(onConnectAI).toHaveBeenCalledOnce()
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
    expect(
      submit.parentElement?.querySelector('[data-component="spinner"], svg.animate-spin, [class*="animate"]'),
    ).toBeTruthy()
    expect(view.queryByText("Starting")).toBeNull()
  })

  test("the spinner leaves and the arrow returns once boot completes", () => {
    const view = renderControl({ booting: false })
    const submit = view.getByRole("button", { name: "Send" })

    expect(submit).not.toHaveAttribute("data-booting")
    expect(view.queryByText("Starting")).toBeNull()
  })
})
