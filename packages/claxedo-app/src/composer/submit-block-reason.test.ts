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
  booting: false,
  stoppable: false,
  blank: false,
}

test("submit block: a workspace whose sandbox is asleep sends, since the send wakes it, though its harness could not be read", () => {
  expect(submitBlockReason({ ...unreadHarness, workspaceAsleep: true })).toBeNull()
  expect(submitBlockReason({ ...unreadHarness, workspaceAsleep: true, blank: true })?.reason).toBe("empty")
  expect(submitBlockReason(unreadHarness)?.reason).toBe("harness-error")
})

test("submit block: a model already chosen sends while its options reload; only a session with no model yet waits for them", () => {
  const loading: SubmitBlockInput = { ...unreadHarness, harnessReadiness: "ready", harnessConfigError: false, harnessOptionsLoading: true }
  expect(submitBlockReason({ ...loading, harnessReadyForSubmit: true })).toBeNull()
  expect(submitBlockReason(loading)?.reason).toBe("models-loading")
})
