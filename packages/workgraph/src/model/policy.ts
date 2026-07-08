import { z } from "zod"
import type {
  Intent,
  PolicyDecision,
  RouteContext,
  RouteOutcome,
  Rule,
  RuleAction,
  RuleCondition,
} from "./policy-types"

type PolicyDefinition = {
  name: string
  schema: z.ZodType
  defaultRules: readonly Rule[]
}

export const DESTRUCTIVE_OPS = Object.freeze([
  "delete_node",
  "merge_nodes",
  "remove_edge_of_in_flight",
  "update_loadout_with_broad_scope",
  "sync_source_hard_to_undo",
] as const)

export const defaultRules: readonly Rule[] = Object.freeze([
  {
    id: "default-high-confidence-apply",
    condition: { minConfidence: 0.8 },
    action: { outcome: "apply" },
  },
  {
    id: "default-low-confidence-clarify",
    condition: { maxConfidence: 0.8 },
    action: { outcome: "clarification" },
  },
])

const policies = new Map<string, PolicyDefinition>()

export function registerPolicy(name: string, schema: z.ZodType, rules: readonly Rule[]) {
  policies.set(name, {
    name,
    schema,
    defaultRules: [...rules],
  })
}

export function getPolicy(name: string) {
  return policies.get(name)
}

export function routeChange(intent: Intent, rules: readonly Rule[], ctx: RouteContext = {}): RouteOutcome {
  const destructiveOp = destructiveOperation(intent)
  if (destructiveOp) return routeDecision("action", `safety-destructive-${destructiveOp}`, intent, {})

  const matchedRule = rules.find((rule) => matchesRule(intent, rule.condition))
  if (matchedRule) return routeRule(intent, matchedRule)

  return intent.confidence >= (ctx.confidenceFloor ?? 0.8)
    ? { outcome: "apply", firedRuleId: "default-high-confidence-apply", intent }
    : routeDecision("clarification", "default-low-confidence-clarify", intent, {})
}

function routeRule(intent: Intent, rule: Rule): RouteOutcome {
  if (rule.action.outcome === "apply") {
    return {
      outcome: "apply",
      firedRuleId: rule.id,
      intent,
    }
  }

  return routeDecision(rule.action.outcome, rule.id, intent, rule.action)
}

function routeDecision(outcome: "clarification" | "action", firedRuleId: string, intent: Intent, action: Partial<RuleAction>): RouteOutcome {
  return {
    outcome,
    firedRuleId,
    decision: buildDecision(outcome, intent, action),
  }
}

function buildDecision(kind: "clarification" | "action", intent: Intent, action: Partial<RuleAction>): PolicyDecision {
  return {
    kind,
    intentKind: intent.intentKind,
    subjectType: intent.subjectType,
    subjectId: intent.subjectId,
    promptMd: action.promptMd ?? defaultPrompt(kind, intent),
    recommendedIntentPayload: intent,
    alternatives: [],
    confidence: intent.confidence,
    evidenceMd: intent.evidenceMd,
    defaultAction: action.defaultAction ?? (kind === "action" ? "reject" : "ask"),
    autoApplyAllowed: false,
  }
}

function defaultPrompt(kind: "clarification" | "action", intent: Intent) {
  if (kind === "action") return `Review the proposed ${intent.intentKind} change before it is applied.`
  return `Clarify the proposed ${intent.intentKind} change before it is applied.`
}

function matchesRule(intent: Intent, condition: RuleCondition) {
  return matchesIntentKind(intent, condition)
    && matchesValue(condition.subjectType, intent.subjectType)
    && matchesValue(condition.classification, intent.classification)
    && matchesValue(condition.inFlight, "inFlight" in intent ? intent.inFlight : undefined)
    && matchesValue(condition.broadScope, "broadScope" in intent ? isBroadLoadoutScope(intent) : undefined)
    && matchesValue(condition.hardToUndo, "hardToUndo" in intent ? intent.hardToUndo : undefined)
    && (condition.minConfidence === undefined || intent.confidence >= condition.minConfidence)
    && (condition.maxConfidence === undefined || intent.confidence <= condition.maxConfidence)
}

function matchesIntentKind(intent: Intent, condition: RuleCondition) {
  if (condition.intentKind === undefined) return true
  if (Array.isArray(condition.intentKind)) return condition.intentKind.includes(intent.intentKind)
  return condition.intentKind === intent.intentKind
}

function matchesValue<T>(expected: T | undefined, actual: T | undefined) {
  return expected === undefined || expected === actual
}

function destructiveOperation(intent: Intent): typeof DESTRUCTIVE_OPS[number] | undefined {
  if (intent.intentKind === "delete_node") return "delete_node"
  if (intent.intentKind === "merge_nodes") return "merge_nodes"
  if (intent.intentKind === "remove_edge" && intent.inFlight === true) return "remove_edge_of_in_flight"
  if (intent.intentKind === "update_loadout" && isBroadLoadoutScope(intent)) return "update_loadout_with_broad_scope"
  if (intent.intentKind === "sync_source" && intent.hardToUndo === true) return "sync_source_hard_to_undo"
  return undefined
}

function isBroadLoadoutScope(intent: Intent) {
  if (intent.intentKind !== "update_loadout") return false
  return intent.broadScope === true || ["repo", "role", "source_adapter", "task_kind", "system"].includes(intent.scopeType)
}

registerPolicy("default", z.object({}), defaultRules)
