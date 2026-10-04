/// <reference types="bun" />
import { expect, test } from "bun:test"
import { resolveHarnessNotice } from "./harness-notice"

const base = { harnessLabel: "Cursor", runtimeUnavailable: false, optionsFailed: false, noModels: false }
const open = () => undefined

test("harness notice: a connection state outranks everything, with its own copy", () => {
  expect(resolveHarnessNotice({ ...base, runtimeUnavailable: true, connectionState: { connectionId: "c", state: "disconnected" } })).toEqual({
    kind: "connection-disconnected",
    tone: "warning",
    message: "Cursor disconnected",
    detail: "The agent connection closed. Your transcript is saved; the next turn can reconnect.",
    retry: false,
  })
  expect(resolveHarnessNotice({ ...base, connectionState: { connectionId: "c", state: "auth-required" } })?.message).toBe("Cursor requires authentication")
  expect(resolveHarnessNotice({ ...base, connectionState: { connectionId: "c", state: "ready" } })).toBeUndefined()
})

test("harness notice: a dead runtime outranks setup, models and the saved model", () => {
  const notice = resolveHarnessNotice({ ...base, runtimeUnavailable: true, optionsFailed: true, savedModelUnavailable: "Opus", setupRequired: true, openProviders: open })
  expect(notice).toMatchObject({ kind: "runtime-unavailable", title: "Agent runtime unreachable after timeout", retry: true })
})

test("harness notice: setup, then failed models, then an unavailable saved model", () => {
  expect(resolveHarnessNotice({ ...base, configError: "missing cursor-sdk API key", openProviders: open })).toMatchObject({ kind: "setup-required", detail: "Add an account in Settings → Models.", action: { label: "Open Models", ariaLabel: "Open Settings Models" } })
  expect(resolveHarnessNotice({ ...base, configError: "boom", noModels: true, savedModelUnavailable: "Opus" })).toEqual({ kind: "models-failed", tone: "critical", message: "Couldn't load Cursor models", detail: "boom", retry: true })
  expect(resolveHarnessNotice({ ...base, savedModelUnavailable: "Opus" })).toEqual({
    kind: "saved-model-unavailable",
    tone: "warning",
    message: "Opus is unavailable",
    detail: "Reconnect its account in Settings → Models, or choose another model.",
    retry: false,
  })
  expect(resolveHarnessNotice(base)).toBeUndefined()
})
