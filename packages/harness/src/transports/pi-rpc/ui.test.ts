import { expect, test } from "bun:test"
import { piUiEvent } from "./ui"

test("a Pi extension's notification keeps its severity, and its status, widget, title and editor pushes are side channels", () => {
  expect(piUiEvent({ type: "extension_ui_request", method: "notify", id: "n", message: "Deployed", notifyType: "warning" })?.event)
    .toMatchObject({ type: "harness-notice", code: "pi.extension_ui.notify", message: "Deployed", severity: "warn" })
  for (const method of ["setStatus", "setWidget", "setTitle", "set_editor_text"]) {
    expect(piUiEvent({ type: "extension_ui_request", method, id: method, statusText: "busy", title: "t", text: "x", widgetLines: ["w"] })?.event)
      .toMatchObject({ type: "harness-notice", code: `pi.extension_ui.${method}`, severity: "debug" })
  }
})
