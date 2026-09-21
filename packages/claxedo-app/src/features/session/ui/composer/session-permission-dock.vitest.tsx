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

test("renders provider labels in order and sends the exact opaque option ID", () => {
  const onDecide = vi.fn()
  const view = render(() => <SessionPermissionDock request={{ ...request, options: [
    { id: "policy/workspace", label: "Trust in this workspace", description: "Provider supplied detail" },
    { id: "dismiss/9", label: "Leave pending" },
  ] }} responding={false} onDecide={onDecide} />)
  expect(view.getAllByRole("button").map((button) => button.textContent)).toEqual(["Trust in this workspace", "Leave pending"])
  const choice = view.getByRole("button", { name: "Trust in this workspace" })
  expect(choice.getAttribute("title")).toBe("Provider supplied detail")
  fireEvent.click(choice)
  expect(onDecide).toHaveBeenCalledWith({ optionId: "policy/workspace" })
})

test("an explicit empty provider option list does not invent generic permission decisions", () => {
  const view = render(() => <SessionPermissionDock request={{ ...request, options: [] }} responding={false} onDecide={() => {}} />)
  expect(view.queryAllByRole("button")).toEqual([])
})

test("renders complete ACP details as plain text without fetching content URLs", () => {
  const details = { rawInput: { cwd: "/work", command: "printf '<img src=https://example.com/track>'" }, content: [{ type: "content", content: { type: "text", text: "<script>agent detail</script>" } }] }
  const view = render(() => <SessionPermissionDock request={{ ...request, metadata: { acpToolCall: details, acpRequestMeta: { permission: { description: "Agent reason" } } } }} responding={false} onDecide={() => {}} />)
  const text = view.container.querySelector('[data-slot="permission-details"]')?.textContent
  expect(text).toContain(details.rawInput.command)
  expect(text).toContain("Agent reason")
  expect(text).toContain("/work")
  expect(view.container.querySelector("img,script,iframe,a")).toBeNull()
})

test("ACP approval shows command, reason, directory and agent text while protocol details stay collapsed", () => {
  const command = "printf '<script>data</script>' > /work/result"
  const view = render(() => <SessionPermissionDock request={{ ...request, patterns: ["/work/result"], metadata: {
    command, reason: "Run command", acpRequestMeta: { permission: { version: 1, description: "Write the file you requested" } },
    acpToolCall: { toolCallId: "opaque-123", status: "pending", rawInput: { command, cwd: "/work" }, content: [{ type: "content", content: { type: "text", text: "Requires access to <private> output" } }] },
  } }} responding={false} onDecide={() => {}} />)
  expect(view.container.querySelector('[data-slot="permission-command"]')?.textContent).toBe(command)
  expect(view.container.querySelector('[data-slot="permission-reason"]')?.textContent).toBe("Write the file you requested")
  expect(view.container.querySelector('[data-slot="permission-directory"]')?.textContent).toBe("Working directory: /work")
  expect(view.container.querySelector('[data-slot="permission-agent-text"]')?.textContent).toBe("Requires access to <private> output")
  expect(view.getByText("/work/result")).toBeTruthy()
  const details = view.container.querySelector<HTMLDetailsElement>('[data-slot="permission-details"]')!
  expect(details.open).toBe(false)
  expect(details.querySelector("summary")?.textContent).toBe("Details")
  expect(details.querySelector("pre")?.textContent).toContain("opaque-123")
  expect(view.container.querySelector("script,img,iframe")).toBeNull()
})
