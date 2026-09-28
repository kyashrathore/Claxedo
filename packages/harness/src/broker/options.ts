import type { PermissionDecision } from "@claxedo/agent-runtime-contract"
import type { PermissionOption, PermissionOptionKind, RequestAnswer } from "../contract/broker"

const optionOrder: Record<PermissionDecision, readonly PermissionOptionKind[]> = {
  allow_once: ["allow_once"],
  allow_always: ["allow_always", "allow_once"],
  deny: ["reject_once", "reject_always"],
  reject_always: ["reject_always", "reject_once"],
}

const optionDecision: Record<PermissionOptionKind, PermissionDecision> = {
  allow_once: "allow_once",
  allow_always: "allow_always",
  reject_once: "deny",
  reject_always: "reject_always",
}

export function chooseBrokerPermissionOption(
  decision: PermissionDecision,
  options: readonly PermissionOption[],
): PermissionOption | undefined {
  return optionOrder[decision]
    .map((kind) => options.find((candidate) => candidate.kind === kind))
    .find((option) => option !== undefined)
}

export function decisionAnswer(decision: PermissionDecision, options: readonly PermissionOption[] | undefined): RequestAnswer {
  if (options === undefined) return { kind: "permission", decision }
  const option = chooseBrokerPermissionOption(decision, options)
  return option ? { kind: "permission", decision: optionDecision[option.kind], optionId: option.optionId } : { kind: "cancelled" }
}

export function offeredOptionAnswer(optionId: string, options: readonly PermissionOption[] | undefined): RequestAnswer | undefined {
  const option = options?.find((candidate) => candidate.optionId === optionId)
  return option && { kind: "permission", decision: optionDecision[option.kind], optionId: option.optionId }
}
