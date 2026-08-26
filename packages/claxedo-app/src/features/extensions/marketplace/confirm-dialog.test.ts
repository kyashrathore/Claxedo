import { describe, expect, it } from "bun:test"
import { runConfirmDialog, type ConfirmDecisionHandlers, type ConfirmDialogHost } from "./confirm-dialog"

function fakeHost() {
  const state = { closeCount: 0, onClose: undefined as (() => void) | undefined, shown: 0 }
  let handlers: ConfirmDecisionHandlers | undefined
  const host: ConfirmDialogHost = {
    show(element, onClose) {
      state.shown++
      state.onClose = onClose
      // Invoke the element factory with a stub builder so we can capture the
      // decision handlers without rendering a live component.
      element()
    },
    close() {
      state.closeCount++
    },
  }
  // The builder only needs to capture the decision handlers; JSX.Element
  // permits null, so no live component is rendered.
  const build = (received: ConfirmDecisionHandlers) => {
    handlers = received
    return null
  }
  return {
    host,
    state,
    build,
    get handlers() {
      return handlers
    },
    run: () => runConfirmDialog(host, build),
  }
}

describe("runConfirmDialog", () => {
  it("resolves true and closes the dialog when the user confirms", async () => {
    const fake = fakeHost()
    const promise = fake.run()
    fake.handlers!.onConfirm()
    expect(await promise).toBe(true)
    expect(fake.state.closeCount).toBe(1)
  })

  it("resolves false and closes when the user cancels", async () => {
    const fake = fakeHost()
    const promise = fake.run()
    fake.handlers!.onCancel()
    expect(await promise).toBe(false)
    expect(fake.state.closeCount).toBe(1)
  })

  it("resolves false when the dialog is dismissed (Esc / backdrop)", async () => {
    const fake = fakeHost()
    const promise = fake.run()
    fake.state.onClose!()
    expect(await promise).toBe(false)
    expect(fake.state.closeCount).toBe(1)
  })

  it("settles and closes exactly once even if confirm then dismiss both fire", async () => {
    const fake = fakeHost()
    const promise = fake.run()
    fake.handlers!.onConfirm()
    fake.state.onClose!()
    fake.handlers!.onCancel()
    expect(await promise).toBe(true)
    expect(fake.state.closeCount).toBe(1)
  })
})
