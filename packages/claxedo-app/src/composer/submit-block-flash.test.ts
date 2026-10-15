/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createSubmitBlockFlash } from "./submit-block-flash"
import { submitBlockReason, type SubmitBlock, type SubmitBlockInput } from "./submit-block-reason"

const ready: SubmitBlockInput = {
  authorityBlock: undefined,
  harnessMode: true,
  harnessReadiness: "ready",
  harnessConfigError: false,
  harnessOptionsLoading: false,
  harnessReadyForSubmit: true,
  modelBlocked: false,
  stoppable: false,
  blank: false,
}

test("Enter under a block that offers nothing to do still shows why, and under none it explains nothing", () => {
  const [block, setBlock] = createSignal<SubmitBlock | null>(submitBlockReason({ ...ready, harnessReadiness: "polling" }))
  let chosen = 0
  const { flash, dispose } = createRoot((dispose) => ({ flash: createSubmitBlockFlash(block, () => { chosen++ }), dispose }))
  expect(block()?.actionable).toBe(false)
  expect(flash.explain()).toBe(true)
  expect(flash.flash()).toBe(true)

  setBlock(submitBlockReason({ ...ready, harnessReadyForSubmit: false }))
  expect(flash.explain()).toBe(true)
  expect(chosen).toBe(1)

  setBlock(null)
  expect(flash.flash()).toBe(false)
  expect(flash.explain()).toBe(false)
  dispose()
})
