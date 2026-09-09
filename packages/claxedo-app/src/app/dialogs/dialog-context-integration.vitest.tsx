import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, test } from "vitest"
import { createResource, ErrorBoundary } from "solid-js"
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

  /**
   * A dialog mounts from the caller's owner, so before the host caught this a
   * throw inside one reached the application's ErrorBoundary: opening Settings
   * against a build whose consent endpoint answered 404 replaced the whole app
   * with the error page, shell and toast region included.
   */
  test("a dialog that throws is contained, leaving the application mounted", async () => {
    function Throwing(): never {
      throw new Error("Connected applications are unavailable")
    }

    render(() => (
      <ErrorBoundary fallback={() => <div data-testid="app-error">application error page</div>}>
        <div data-testid="app-content">the app</div>
        <DialogProvider>
          <ThrowingHarness />
        </DialogProvider>
      </ErrorBoundary>
    ))

    function ThrowingHarness() {
      const dialog = useDialog()
      return (
        <button type="button" onClick={() => dialog.show(() => <Throwing />)}>
          show throwing
        </button>
      )
    }

    fireEvent.click(screen.getByText("show throwing"))

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy())
    expect(screen.getByRole("alert").textContent).toContain("Connected applications are unavailable")
    expect(screen.queryByTestId("app-error")).toBeNull()
    expect(screen.getByTestId("app-content")).toBeTruthy()
  })

  test("the contained failure can be dismissed", async () => {
    function Throwing(): never {
      throw new Error("boom")
    }
    function ThrowingHarness() {
      const dialog = useDialog()
      return (
        <button type="button" onClick={() => dialog.show(() => <Throwing />)}>
          show throwing
        </button>
      )
    }

    render(() => (
      <DialogProvider>
        <ThrowingHarness />
      </DialogProvider>
    ))

    fireEvent.click(screen.getByText("show throwing"))
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy())

    // A dialog mounts in its own root, which `cleanup()` does not reach, so
    // dialogs from earlier tests are still in the document — this one is last.
    const buttons = screen.getAllByTestId("dialog-error-close")
    fireEvent.click(buttons[buttons.length - 1])

    await waitFor(() => expect(screen.queryByText("boom")).toBeNull())
  })

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
