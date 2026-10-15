/// <reference types="bun" />
import { expect, test } from "bun:test"
import { submitBlockReason, type SubmitBlockInput } from "./submit-block-reason"

const unreadHarness: SubmitBlockInput = {
  authorityBlock: undefined,
  harnessMode: true,
  harnessReadiness: "error",
  harnessConfigError: true,
  harnessOptionsLoading: false,
  harnessReadyForSubmit: false,
  modelBlocked: false,
  stoppable: false,
  blank: false,
}

test("submit block: a workspace whose sandbox is asleep sends, since the send wakes it, though its harness could not be read", () => {
  expect(submitBlockReason({ ...unreadHarness, workspaceAsleep: true })).toBeNull()
  expect(submitBlockReason({ ...unreadHarness, workspaceAsleep: true, blank: true })?.reason).toBe("empty")
  expect(submitBlockReason(unreadHarness)?.reason).toBe("harness-error")
})

test("submit block: an asleep workspace never sends to a harness nobody chose; Send stays blocked on the model choice until one is", () => {
  const noHarness: SubmitBlockInput = { ...unreadHarness, harnessMode: false, modelBlocked: true, workspaceAsleep: true }
  expect(submitBlockReason(noHarness)?.reason).toBe("no-model")
  expect(submitBlockReason({ ...noHarness, blank: true })?.reason).toBe("no-model")
  expect(submitBlockReason({ ...noHarness, workspaceAsleep: false })?.reason).toBe("no-model")
})

test("submit block: a harness whose account its provider refused never sends; Send names the refusal and offers Open Models, ahead of the error the refused options load also left", () => {
  const refused: SubmitBlockInput = { ...unreadHarness, harnessReadiness: "ready", harnessConfigError: true, harnessReadyForSubmit: false, accountUnavailable: { reason: "auth_failed" } }
  expect(submitBlockReason(refused)).toEqual({ reason: "account-refused", copy: "The agent's account was refused by its provider", actionable: true, action: "open-models" })
  expect(submitBlockReason({ ...refused, accountUnavailable: { reason: "expired" } })?.reason).toBe("account-refused")
  expect(submitBlockReason({ ...refused, accountUnavailable: { reason: "no_billing" } })?.reason).toBe("account-refused")
  expect(submitBlockReason({ ...refused, accountUnavailable: { reason: "placeholder_env_missing: ANTHROPIC_API_KEY" } })).toEqual({ reason: "account-unusable", copy: "The agent's account can't be used here", actionable: true, action: "open-models" })
  expect(submitBlockReason({ ...refused, accountUnavailable: {} })).toEqual({ reason: "account-not-set-up", copy: "The agent has no account yet", actionable: true, action: "open-models" })
})

test("submit block: a model already chosen sends while its options reload; only a session with no model yet waits for them", () => {
  const loading: SubmitBlockInput = { ...unreadHarness, harnessReadiness: "ready", harnessConfigError: false, harnessOptionsLoading: true }
  expect(submitBlockReason({ ...loading, harnessReadyForSubmit: true })).toBeNull()
  expect(submitBlockReason(loading)?.reason).toBe("models-loading")
})
