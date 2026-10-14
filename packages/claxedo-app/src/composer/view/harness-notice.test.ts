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
  expect(resolveHarnessNotice({ ...base, harnessLabel: "Pi", accountRefused: true, configError: "No model options available", noModels: true, openProviders: open })).toEqual({
    kind: "account-refused",
    tone: "warning",
    message: "Pi's account was refused by its provider",
    detail: "Reconnect it in Settings → Models, or add another account.",
    retry: false,
    action: { label: "Open Models", ariaLabel: "Open Settings Models", run: open },
  })
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

test("harness notice: a harness this cloud provider cannot run outranks every load failure and carries its one action", () => {
  const run = () => undefined
  const unavailableHere = { message: "Claude Code runs inside the workspace", detail: "Use Claude Sonnet 5.5 through Pi — same account.", action: { label: "Switch to Pi", run } }
  expect(resolveHarnessNotice({ ...base, runtimeUnavailable: true, optionsFailed: true, configError: "boom", noModels: true, setupRequired: true, openProviders: open, unavailableHere }))
    .toEqual({ kind: "unavailable-here", tone: "warning", retry: false, ...unavailableHere })
  expect(resolveHarnessNotice({ ...base, asleep: true, unavailableHere })).toBeUndefined()
})

test("harness notice: an account the options route refused is named by its health, never as a failed model load with a retry", () => {
  const unusable = { ...base, harnessLabel: "Claude Code", configError: "The account chosen for this harness can't be used here. Check it in Settings → Models.", noModels: true, openProviders: open }
  expect(resolveHarnessNotice({ ...unusable, accountUnavailable: { reason: "auth_failed" } })).toEqual({
    kind: "account-refused",
    tone: "warning",
    message: "Claude Code's account was refused by its provider",
    detail: "Reconnect it in Settings → Models, or add another account.",
    retry: false,
    action: { label: "Open Models", ariaLabel: "Open Settings Models", run: open },
  })
  expect(resolveHarnessNotice({ ...unusable, accountUnavailable: { reason: "expired" } })?.kind).toBe("account-refused")
  expect(resolveHarnessNotice({ ...unusable, accountUnavailable: { reason: "placeholder_env_missing: ANTHROPIC_API_KEY" } })).toMatchObject({
    kind: "account-unusable",
    message: "Claude Code's account can't be used here",
    detail: unusable.configError,
    retry: false,
  })
  expect(resolveHarnessNotice({ ...unusable, configError: "No account is chosen for this harness. Add one in Settings → Models.", accountUnavailable: {} })?.kind).toBe("setup-required")
  expect(resolveHarnessNotice({ ...unusable, accountUnavailable: { reason: "auth_failed" }, openProviders: undefined })?.kind).toBe("models-failed")
})
