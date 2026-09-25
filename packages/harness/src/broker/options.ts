import type { PermissionDecision } from "@claxedo/agent-runtime-contract"
import type { PermissionOption, PermissionOptionKind, RequestAnswer } from "../contract/broker"

const optionOrder: Record<PermissionDecision, readonly PermissionOptionKind[]> = {
  allow_once: ["allow_once"],
  allow_always: ["allow_always", "allow_once"],
  deny: ["reject_once", "reject_always"],
  reject_always: ["reject_always", "reject_once"],
}

export function chooseBrokerPermissionOption(
  decision: PermissionDecision,
  options: readonly PermissionOption[],
): PermissionOption | undefined {
  return optionOrder[decision]
    .map((kind) => options.find((candidate) => candidate.kind === kind))
    .find((option) => option !== undefined)
}

export function optionMatchesDecision(decision: PermissionDecision, kind: PermissionOptionKind): boolean {
  return optionOrder[decision].includes(kind)
}

export function substitutePermissionOption(
  answer: Extract<RequestAnswer, { kind: "permission" }>,
  options: readonly PermissionOption[] | undefined,
): RequestAnswer {
  if (options === undefined || answer.optionId !== undefined) return answer
  const option = chooseBrokerPermissionOption(answer.decision, options)
  return option ? { ...answer, optionId: option.optionId } : { kind: "cancelled" }
}
