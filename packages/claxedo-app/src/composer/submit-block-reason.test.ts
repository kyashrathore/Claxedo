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
  needsModelSelection: false,
  modelBlocked: false,
  modelBlockLabel: undefined,
  providerLoading: false,
  booting: false,
  stoppable: false,
  blank: false,
}

test("submit block: a workspace whose sandbox is asleep sends, since the send wakes it, though its harness could not be read", () => {
  expect(submitBlockReason({ ...unreadHarness, workspaceAsleep: true })).toBeNull()
  expect(submitBlockReason({ ...unreadHarness, workspaceAsleep: true, blank: true })?.reason).toBe("empty")
  expect(submitBlockReason(unreadHarness)?.reason).toBe("harness-error")
})
