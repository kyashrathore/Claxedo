import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library"
import { afterEach, expect, test, vi } from "vitest"
import { SessionPermissionDock } from "./session-permission-dock"

vi.mock("@/platform/i18n/provider", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
afterEach(cleanup)
const request = { id: "permission-1", sessionID: "owner", permission: "Bash", patterns: [], always: [], metadata: {} }

test("Stop blocks conflicting decisions and exposes an abort failure for retry", async () => {
  let reject!: (error: Error) => void
  const onStop = vi.fn(() => new Promise<void>((_, fail) => { reject = fail }))
  const onDecide = vi.fn()
  const view = render(() => <SessionPermissionDock request={request} responding={false} onDecide={onDecide} onStop={onStop} />)
  const stop = view.getByRole("button", { name: "prompt.action.stop" }) as HTMLButtonElement
  fireEvent.click(stop)
  expect(onStop).toHaveBeenCalledTimes(1)
  expect(stop.disabled).toBe(true)
  expect(view.getByRole<HTMLButtonElement>("button", { name: "ui.permission.allowAlways" }).disabled).toBe(true)
  expect(onDecide).not.toHaveBeenCalled()
  reject(new Error("Server could not stop the turn"))
  await waitFor(() => expect(view.getByRole("alert").textContent).toBe("Server could not stop the turn"))
  expect(stop.disabled).toBe(false)
  onStop.mockResolvedValueOnce()
  fireEvent.click(stop)
  await waitFor(() => expect(stop.disabled).toBe(false))
  expect(onStop).toHaveBeenCalledTimes(2)
  expect(view.queryByRole("alert")).toBeNull()
})

test("an unavailable abort operation has no Stop action", () => {
  const view = render(() => <SessionPermissionDock request={request} responding={false} onDecide={() => {}} />)
  expect(view.queryByRole("button", { name: "prompt.action.stop" })).toBeNull()
})

test("shows native command and reason as text without interpreting shell or HTML", () => {
  const command = "printf '<script>alert(1)</script>' > /tmp/result"
  const view = render(() => <SessionPermissionDock request={{ ...request, metadata: { command, reason: "Write the requested result" } }} responding={false} onDecide={() => {}} />)
  expect(view.container.querySelector('[data-slot="permission-command"]')?.textContent).toBe(command)
  expect(view.getByText("Write the requested result")).toBeTruthy()
  expect(view.container.querySelector("script")).toBeNull()
})
