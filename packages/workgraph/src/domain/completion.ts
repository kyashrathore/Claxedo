import type {
  CompletionContract,
  CompletionRequirement,
  EvidenceDto,
  EvidenceSubject,
} from "../contracts/completion"
import type { WorkGraphActor } from "../contracts/context"
import type { OutcomeState, WorkItemState } from "../contracts/lifecycle"

export interface CompletionRequirementResult {
  readonly requirementId: string
  readonly satisfied: boolean
  readonly evidenceId?: string
}

export interface CompletionEvaluation {
  readonly subject: EvidenceSubject
  readonly satisfied: boolean
  readonly requirementResults: readonly CompletionRequirementResult[]
}

export function evaluateCompletionContract(
  contract: CompletionContract,
  subject: EvidenceSubject,
  evidence: readonly EvidenceDto[],
): CompletionEvaluation {
  const requirementResults = contract.requirements.map((requirement) => {
    const latest = evidence.reduce<EvidenceDto | undefined>((selected, candidate) => {
      if (!sameSubject(candidate.subject, subject)) return selected
      if (candidate.requirementId !== requirement.id) return selected
      if (!selected || compareEvidence(candidate, selected) > 0) return candidate
      return selected
    }, undefined)
    return {
      requirementId: requirement.id,
      satisfied: latest ? satisfiesRequirement(requirement, latest) : false,
      ...(latest ? { evidenceId: latest.id } : {}),
    }
  })

  return {
    subject,
    satisfied:
      contract.mode === "all"
        ? requirementResults.every((result) => result.satisfied)
        : requirementResults.some((result) => result.satisfied),
    requirementResults,
  }
}

export type WorkItemCompletionResult =
  | { readonly ok: true; readonly state: "completed" }
  | { readonly ok: false; readonly error: { readonly code: "result_not_ready" | "completion_contract_unsatisfied" } }

export function completeWorkItem(input: {
  readonly workItemId: string
  readonly state: WorkItemState
  readonly evaluation: CompletionEvaluation
}): WorkItemCompletionResult {
  if (input.evaluation.subject.type !== "work_item" || input.evaluation.subject.workItemId !== input.workItemId) {
    return { ok: false, error: { code: "completion_contract_unsatisfied" } }
  }
  if (!(["result_ready", "review_needed", "integration_needed"] as readonly WorkItemState[]).includes(input.state)) {
    return { ok: false, error: { code: "result_not_ready" } }
  }
  if (!input.evaluation.satisfied) return { ok: false, error: { code: "completion_contract_unsatisfied" } }
  return { ok: true, state: "completed" }
}

export type OutcomeCompletionResult =
  | {
      readonly ok: true
      readonly state: "completed"
      readonly provenance: {
        readonly ownerConfirmationEvidenceId: string
        readonly closedAt: number
        readonly closedBy: WorkGraphActor
      }
    }
  | {
      readonly ok: false
      readonly error: {
        readonly code: "outcome_not_ready" | "unfinished_work_items" | "owner_confirmation_required"
      }
    }

export function completeOutcome(input: {
  readonly outcomeId: string
  readonly ownerUserId: string
  readonly state: OutcomeState
  readonly childStates: readonly WorkItemState[]
  readonly ownerConfirmation: EvidenceDto | undefined
  readonly closedAt: number
  readonly closedBy: WorkGraphActor
}): OutcomeCompletionResult {
  if (input.state !== "ready_to_close") return { ok: false, error: { code: "outcome_not_ready" } }
  if (input.childStates.some((state) => state !== "completed" && state !== "abandoned")) {
    return { ok: false, error: { code: "unfinished_work_items" } }
  }
  if (
    input.ownerConfirmation?.kind !== "owner_confirmation" ||
    !input.ownerConfirmation.confirmed ||
    input.ownerConfirmation.subject.type !== "outcome" ||
    input.ownerConfirmation.subject.outcomeId !== input.outcomeId ||
    input.ownerConfirmation.recordedBy.type !== "user" ||
    input.ownerConfirmation.recordedBy.id !== input.ownerUserId ||
    input.closedBy.type !== "user" ||
    input.closedBy.id !== input.ownerUserId
  ) {
    return { ok: false, error: { code: "owner_confirmation_required" } }
  }
  return {
    ok: true,
    state: "completed",
    provenance: {
      ownerConfirmationEvidenceId: input.ownerConfirmation.id,
      closedAt: input.closedAt,
      closedBy: input.closedBy,
    },
  }
}

export type OutcomeReopenResult =
  | {
      readonly ok: true
      readonly state: "reopened"
      readonly provenance: {
        readonly reopenedAt: number
        readonly reopenedBy: WorkGraphActor
        readonly reason: string
      }
    }
  | { readonly ok: false; readonly error: { readonly code: "outcome_not_completed" | "reopen_reason_required" } }

export function reopenOutcome(input: {
  readonly state: OutcomeState
  readonly reopenedAt: number
  readonly reopenedBy: WorkGraphActor
  readonly reason: string
}): OutcomeReopenResult {
  if (input.state !== "completed") return { ok: false, error: { code: "outcome_not_completed" } }
  if (!input.reason.trim()) return { ok: false, error: { code: "reopen_reason_required" } }
  return {
    ok: true,
    state: "reopened",
    provenance: { reopenedAt: input.reopenedAt, reopenedBy: input.reopenedBy, reason: input.reason.trim() },
  }
}

function satisfiesRequirement(requirement: CompletionRequirement, evidence: EvidenceDto) {
  if (requirement.kind === "test") {
    return evidence.kind === "test_result" && evidence.passed && (!requirement.command || evidence.command === requirement.command)
  }
  if (requirement.kind === "artifact") {
    return evidence.kind === "artifact" && (!requirement.artifactType || evidence.mediaType === requirement.artifactType)
  }
  if (requirement.kind === "review") {
    return evidence.kind === "review" && evidence.verdict === "approved" && (!requirement.reviewerRole || evidence.reviewer === requirement.reviewerRole)
  }
  if (requirement.kind === "integration") {
    return evidence.kind === "integration" && (!requirement.target || evidence.reference === requirement.target)
  }
  // Verification instructions are descriptive for a human/agent verifier; the typed result is the enforceable signal.
  if (requirement.kind === "verification") return evidence.kind === "test_result" && evidence.passed
  return evidence.kind === "owner_confirmation" && evidence.confirmed
}

function sameSubject(left: EvidenceSubject, right: EvidenceSubject) {
  if (left.type !== right.type) return false
  if (left.type === "stream" && right.type === "stream") return left.streamId === right.streamId
  if (left.type === "work_item" && right.type === "work_item") return left.workItemId === right.workItemId
  return left.type === "outcome" && right.type === "outcome" && left.outcomeId === right.outcomeId
}

function compareEvidence(left: EvidenceDto, right: EvidenceDto) {
  if (left.recordedAt !== right.recordedAt) return left.recordedAt - right.recordedAt
  return left.id.localeCompare(right.id)
}
