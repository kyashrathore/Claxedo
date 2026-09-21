import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import { Dialog } from "@opencode-ai/ui/dialog"
import { DialogProvider, useDialog } from "@opencode-ai/ui/context/dialog"
import { requestConfirm, type ConfirmOptions } from "./confirm"

afterEach(() => {
  cleanup()
  // The dialog host portals outside the render container and disposes on a
  // timer, so a dialog still open when a test ends outlives `cleanup()` and
  // would hide the next test's tree behind its modal.
  document.body.replaceChildren()
})

const OPTIONS: ConfirmOptions = {
  title: "Disable context7?",
  body: "This removes its config and materialized files.",
  confirmLabel: "Disable",
}

function Probe(props: { options: ConfirmOptions; onDecision: (value: boolean) => void }) {
  const dialog = useDialog()
  return (
    <>
      <button type="button" onClick={() => void requestConfirm(dialog, props.options).then(props.onDecision)}>
        ask
      </button>
      <button type="button" onClick={() => void dialog.push(() => <Dialog title="Underneath" fit><p>still open</p></Dialog>)}>
        open underneath
      </button>
    </>
  )
}

/**
 * The trigger nodes are captured before anything opens: a Kobalte modal marks
 * the rest of the page `aria-hidden`, so a role query for them stops resolving
 * the moment a dialog is up.
 */
async function ask(options: ConfirmOptions = OPTIONS) {
  const onDecision = vi.fn()
  render(() => (
    <DialogProvider>
      <Probe options={options} onDecision={onDecision} />
    </DialogProvider>
  ))
  const askButton = screen.getByRole("button", { name: "ask" })
  const underneathButton = screen.getByRole("button", { name: "open underneath" })
  return {
    onDecision,
    openUnderneath: () => fireEvent.click(underneathButton),
    open: async () => {
      await fireEvent.click(askButton)
      return await screen.findByText(options.body)
        .then((body) => body.closest<HTMLElement>("[data-component='dialog']")!)
    },
  }
}

describe("requestConfirm", () => {
  test("names what the action costs and resolves true when the destructive label is pressed", async () => {
    const { onDecision, open } = await ask()

    const dialog = await open()
    expect(screen.getByText("Disable context7?")).toBeVisible()
    expect(screen.getByText("This removes its config and materialized files.")).toBeVisible()
    await fireEvent.click(within(dialog).getByRole("button", { name: "Disable" }))

    await waitFor(() => expect(onDecision).toHaveBeenCalledWith(true))
    await waitFor(() => expect(screen.queryByText(OPTIONS.body)).toBeNull())
  })

  test("Cancel resolves false", async () => {
    const { onDecision, open } = await ask()

    const dialog = await open()
    await fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))

    await waitFor(() => expect(onDecision).toHaveBeenCalledWith(false))
  })

  test("a dismissal is a decision: Escape resolves false rather than hanging", async () => {
    const { onDecision, open } = await ask()

    await open()
    await fireEvent.keyDown(window, { key: "Escape" })

    await waitFor(() => expect(onDecision).toHaveBeenCalledWith(false))
  })

  test("Cancel followed by a dismissal decides once and leaves the dialog underneath standing", async () => {
    const { onDecision, open, openUnderneath } = await ask()
    await openUnderneath()
    await screen.findByText("still open")

    const dialog = await open()
    await fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))
    await fireEvent.keyDown(window, { key: "Escape" })

    await waitFor(() => expect(onDecision).toHaveBeenCalledTimes(1))
    expect(onDecision).toHaveBeenCalledWith(false)
    expect(screen.getByText("still open")).toBeVisible()
  })

  test("the caller names both labels", async () => {
    const { onDecision, open } = await ask({ ...OPTIONS, confirmLabel: "Remove", cancelLabel: "Keep it" })

    const dialog = await open()
    expect(within(dialog).queryByRole("button", { name: "Cancel" })).toBeNull()
    await fireEvent.click(within(dialog).getByRole("button", { name: "Keep it" }))

    await waitFor(() => expect(onDecision).toHaveBeenCalledWith(false))
  })
})
