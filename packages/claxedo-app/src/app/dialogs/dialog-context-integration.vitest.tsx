import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, test } from "vitest"
import { createResource } from "solid-js"
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

/** Every dialog opened through `lazyDialog` reaches the stack this way: mounted, then suspended on its chunk. */
function SuspendingDialog(props: { ready: Promise<void> }) {
  const [chunk] = createResource(async () => {
    await props.ready
    return "loaded"
  })
  return <div data-testid="dialog-lazy">{chunk()}</div>
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

  test("show holds the replaced dialog on screen until the replacement resolves", async () => {
    let ready: (() => void) | undefined
    const chunk = new Promise<void>((resolve) => {
      ready = resolve
    })

    function Opener() {
      const dialog = useDialog()
      return (
        <button
          type="button"
          onClick={() => dialog.show(() => <SuspendingDialog ready={chunk} />)}
        >
          show lazy
        </button>
      )
    }

    render(() => (
      <DialogProvider>
        <DialogHarness />
        <Opener />
      </DialogProvider>
    ))

    fireEvent.click(screen.getByText("show a"))
    await waitFor(() => expect(screen.getByTestId("dialog-a")).toBeTruthy())

    fireEvent.click(screen.getByText("show lazy"))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.getByTestId("dialog-a")).toBeTruthy()
    expect(screen.queryByTestId("dialog-lazy")).toBeNull()

    ready?.()
    await waitFor(() => expect(screen.getByTestId("dialog-lazy")).toBeTruthy())
    expect(screen.queryByTestId("dialog-a")).toBeNull()
  })
})
