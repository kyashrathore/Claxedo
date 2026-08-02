import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, test } from "vitest"
import { DialogProvider, useDialog } from "@opencode-ai/ui/context/dialog"

function DialogHarness() {
  const dialog = useDialog()
  return (
    <>
      <button type="button" onClick={() => dialog.show(() => <div data-testid="dialog-a">A</div>)}>
        show a
      </button>
      <button type="button" onClick={() => dialog.push(() => <div data-testid="dialog-b">B</div>)}>
        push b
      </button>
      <button type="button" onClick={() => dialog.show(() => <div data-testid="dialog-c">C</div>)}>
        show c
      </button>
      <div data-testid="dialog-active">{dialog.active ? "active" : "inactive"}</div>
    </>
  )
}

describe("DialogProvider stack behavior", () => {
  afterEach(() => cleanup())

  test("push stacks dialogs and show replaces the stack", async () => {
    render(() => (
      <DialogProvider>
        <DialogHarness />
      </DialogProvider>
    ))

    fireEvent.click(screen.getByText("show a"))
    await waitFor(() => expect(screen.getByTestId("dialog-a")).toBeTruthy())
    expect(screen.getByTestId("dialog-active").textContent).toBe("active")

    fireEvent.click(screen.getByText("push b"))
    await waitFor(() => expect(screen.getByTestId("dialog-b")).toBeTruthy())
    expect(screen.getByTestId("dialog-a")).toBeTruthy()

    fireEvent.click(screen.getByText("show c"))
    await waitFor(() => expect(screen.getByTestId("dialog-c")).toBeTruthy())
    expect(screen.queryByTestId("dialog-a")).toBeNull()
    expect(screen.queryByTestId("dialog-b")).toBeNull()
  })
})
