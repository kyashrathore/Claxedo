import { describe, expect, test } from "vitest"
import { z } from "zod"
import { defaultRules, getPolicy, registerPolicy, routeChange } from "../src/model/policy"
import type { Intent, Rule } from "../src/model/policy-types"

function intent(overrides: Partial<Intent> = {}): Intent {
  return {
    intentKind: "add_node",
    subjectType: "intake_item",
    subjectId: "intake_1",
    confidence: 0.92,
    evidenceMd: "The scratchpad clearly describes one new task.",
    title: "Fix flaky sync",
    description: "Investigate intermittent sync failures.",
    parentId: null,
    labels: ["sync"],
    ...overrides,
  } as Intent
}

describe("AutoPolicy router", () => {
  test("routes destructive intents to action before user rules", () => {
    const rules: Rule[] = [{
      id: "user-apply-all",
      condition: { intentKind: "delete_node", minConfidence: 0 },
      action: { outcome: "apply" },
    }]

    const outcome = routeChange(intent({
      intentKind: "delete_node",
      subjectType: "work_item",
      subjectId: "item_1",
      confidence: 0.99,
      nodeId: "item_1",
    }), rules)

    expect(outcome.outcome).toBe("action")
    expect(outcome.firedRuleId).toBe("safety-destructive-delete_node")
    expect(outcome.decision.intentKind).toBe("delete_node")
    expect(outcome.decision.autoApplyAllowed).toBe(false)
  })

  test("applies high-confidence safe additions", () => {
    expect(routeChange(intent(), defaultRules)).toEqual({
      outcome: "apply",
      firedRuleId: "default-high-confidence-apply",
      intent: intent(),
    })
  })

  test("asks for clarification on low-confidence additions", () => {
    const outcome = routeChange(intent({ confidence: 0.31 }), defaultRules)

    expect(outcome.outcome).toBe("clarification")
    expect(outcome.firedRuleId).toBe("default-low-confidence-clarify")
    expect(outcome.decision.intentKind).toBe("add_node")
    expect(outcome.decision.recommendedIntentPayload).toEqual(intent({ confidence: 0.31 }))
  })

  test("honors user clarification rules and records their id", () => {
    const outcome = routeChange(intent({
      classification: "ambiguous",
      confidence: 0.88,
    }), [{
      id: "ask-ambiguous",
      condition: { classification: "ambiguous" },
      action: { outcome: "clarification", promptMd: "This looks ambiguous. What should happen?" },
    }])

    expect(outcome.outcome).toBe("clarification")
    expect(outcome.firedRuleId).toBe("ask-ambiguous")
    expect(outcome.decision.promptMd).toBe("This looks ambiguous. What should happen?")
  })

  test("does not let user apply rules bypass destructive loadout changes", () => {
    const outcome = routeChange(intent({
      intentKind: "update_loadout",
      subjectType: "loadout_slot",
      subjectId: "slot_1",
      confidence: 0.97,
      scopeType: "repo",
      scopeId: "github:acme/app",
      loadoutKind: "auto_policy",
      payload: { name: "hands-off" },
    }), [{
      id: "apply-loadouts",
      condition: { intentKind: "update_loadout", minConfidence: 0.9 },
      action: { outcome: "apply" },
    }])

    expect(outcome.outcome).toBe("action")
    expect(outcome.firedRuleId).toBe("safety-destructive-update_loadout_with_broad_scope")
  })

  test("always returns a fired rule id", () => {
    const outcomes = [
      routeChange(intent(), defaultRules),
      routeChange(intent({ confidence: 0.2 }), defaultRules),
      routeChange(intent({ intentKind: "merge_nodes", sourceNodeIds: ["a", "b"], targetNodeId: "a" }), defaultRules),
    ]

    expect(outcomes.every((outcome) => outcome.firedRuleId.length > 0)).toBe(true)
  })

  test("uses the default confidence floor when no rules are configured", () => {
    const outcome = routeChange(intent({ confidence: 0.49 }), [])

    expect(outcome.outcome).toBe("clarification")
    expect(outcome.firedRuleId).toBe("default-low-confidence-clarify")
  })

  test("registers and retrieves named policy definitions", () => {
    const schema = z.object({ floor: z.number().min(0).max(1) })

    registerPolicy("strict", schema, [{
      id: "strict-floor",
      condition: { maxConfidence: 0.95 },
      action: { outcome: "clarification" },
    }])

    expect(getPolicy("strict")?.name).toBe("strict")
    expect(getPolicy("strict")?.schema).toBe(schema)
    expect(getPolicy("strict")?.defaultRules).toEqual([{
      id: "strict-floor",
      condition: { maxConfidence: 0.95 },
      action: { outcome: "clarification" },
    }])
  })
})
