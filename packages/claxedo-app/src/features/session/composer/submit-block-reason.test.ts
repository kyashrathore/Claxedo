import { describe, expect, test } from "bun:test"
import { submitBlockReason, type SubmitBlockInput } from "./submit-block-reason"

// A healthy, typed composer: nothing blocks Send.
const healthy: SubmitBlockInput = {
  roleBlocked: false,
  harnessMode: false,
  harnessReadiness: "ready",
  harnessConfigError: false,
  harnessOptionsLoading: false,
  harnessReadyForSubmit: true,
  needsModelSelection: false,
  modelBlocked: false,
  modelBlockLabel: undefined,
  providerLoading: false,
  booting: false,
  stoppable: false,
  blank: false,
}

const input = (over: Partial<SubmitBlockInput>): SubmitBlockInput => ({ ...healthy, ...over })

describe("submitBlockReason", () => {
  test("a healthy, typed composer is not blocked", () => {
    expect(submitBlockReason(healthy)).toBeNull()
  })

  test("empty prompt alone → empty (inert)", () => {
    expect(submitBlockReason(input({ blank: true }))).toEqual({
      reason: "empty",
      copy: "Type a message to get started",
      actionable: false,
    })
  })

  test("busy composer with a blank prompt is not blocked (Stop stays live)", () => {
    expect(submitBlockReason(input({ blank: true, stoppable: true }))).toBeNull()
  })

  describe("priority ordering", () => {
    test("viewer beats everything else", () => {
      const reason = submitBlockReason(
        input({
          roleBlocked: true,
          harnessMode: true,
          harnessReadiness: "degraded",
          modelBlocked: true,
          modelBlockLabel: "Select model",
          providerLoading: true,
          booting: true,
          blank: true,
        }),
      )
      expect(reason?.reason).toBe("viewer-role")
    })

    test("degraded + empty → harness-degraded wins", () => {
      const reason = submitBlockReason(input({ harnessMode: true, harnessReadiness: "degraded", blank: true }))
      expect(reason?.reason).toBe("harness-degraded")
    })

    test("harness-error beats polling/model/empty", () => {
      const reason = submitBlockReason(
        input({ harnessMode: true, harnessReadiness: "error", booting: true, blank: true }),
      )
      expect(reason?.reason).toBe("harness-error")
    })

    test("configError while ready still reads as harness-error", () => {
      const reason = submitBlockReason(input({ harnessMode: true, harnessReadiness: "ready", harnessConfigError: true }))
      expect(reason?.reason).toBe("harness-error")
    })

    test("polling beats a missing model", () => {
      const reason = submitBlockReason(
        input({ harnessMode: true, harnessReadiness: "polling", harnessReadyForSubmit: false }),
      )
      expect(reason?.reason).toBe("harness-polling")
    })

    test("booting beats empty", () => {
      const reason = submitBlockReason(input({ booting: true, blank: true }))
      expect(reason?.reason).toBe("booting")
    })
  })

  describe("harness readiness", () => {
    test("degraded is actionable", () => {
      expect(submitBlockReason(input({ harnessMode: true, harnessReadiness: "degraded" }))).toEqual({
        reason: "harness-degraded",
        copy: "The agent stopped responding",
        actionable: true,
      })
    })

    test("error is actionable", () => {
      expect(submitBlockReason(input({ harnessMode: true, harnessReadiness: "error" }))?.actionable).toBe(true)
    })

    test("polling is inert", () => {
      expect(submitBlockReason(input({ harnessMode: true, harnessReadiness: "polling" }))).toEqual({
        reason: "harness-polling",
        copy: "Checking the agent…",
        actionable: false,
      })
    })

    test("ready but still loading options → models-loading (inert)", () => {
      expect(
        submitBlockReason(
          input({ harnessMode: true, harnessReadiness: "ready", harnessOptionsLoading: true, harnessReadyForSubmit: false }),
        ),
      ).toEqual({ reason: "models-loading", copy: "Loading models…", actionable: false })
    })

    test("ready but no submittable model → no-model (actionable)", () => {
      expect(
        submitBlockReason(input({ harnessMode: true, harnessReadiness: "ready", harnessReadyForSubmit: false })),
      ).toEqual({ reason: "no-model", copy: "Choose a model to continue", actionable: true })
    })

    test("ready harness that needs an explicit model choice → no-model", () => {
      expect(
        submitBlockReason(input({ harnessMode: true, harnessReadiness: "ready", needsModelSelection: true }))?.reason,
      ).toBe("no-model")
    })

    test("harness readiness is ignored in opencode mode", () => {
      // harnessMode false: an "error" readiness must not leak into the opencode composer.
      expect(submitBlockReason(input({ harnessMode: false, harnessReadiness: "error" }))).toBeNull()
    })
  })

  describe("opencode model gating", () => {
    test("blocked with 'Select model' label → no-model (actionable)", () => {
      expect(submitBlockReason(input({ modelBlocked: true, modelBlockLabel: "Select model" }))?.reason).toBe("no-model")
    })

    test("blocked while providers load → models-loading (inert)", () => {
      expect(
        submitBlockReason(input({ modelBlocked: true, modelBlockLabel: "Loading models", providerLoading: true })),
      ).toEqual({ reason: "models-loading", copy: "Loading models…", actionable: false })
    })

    test("needs-model-selection blocks even outside harness mode", () => {
      expect(submitBlockReason(input({ needsModelSelection: true }))?.reason).toBe("no-model")
    })

    test("providers refreshing with a valid model selected does NOT block", () => {
      // modelBlocked stays false when a usable model is selected; a background
      // provider refresh must not gate Send.
      expect(submitBlockReason(input({ modelBlocked: false, providerLoading: true }))).toBeNull()
    })
  })

  test("every reason carries non-empty copy", () => {
    const cases: SubmitBlockInput[] = [
      input({ roleBlocked: true }),
      input({ harnessMode: true, harnessReadiness: "degraded" }),
      input({ harnessMode: true, harnessReadiness: "error" }),
      input({ harnessMode: true, harnessReadiness: "polling" }),
      input({ modelBlocked: true, modelBlockLabel: "Select model" }),
      input({ modelBlocked: true, modelBlockLabel: "Loading models" }),
      input({ booting: true }),
      input({ blank: true }),
    ]
    for (const c of cases) {
      const reason = submitBlockReason(c)
      expect(reason).not.toBeNull()
      expect(reason?.copy.length ?? 0).toBeGreaterThan(0)
    }
  })
})
