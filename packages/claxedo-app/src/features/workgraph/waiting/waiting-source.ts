import type {
  AdmissionProposalDto,
  AttemptDetailDto,
  AttentionCursor,
  AttentionItem,
  AttentionPage,
  CommandResult,
  DecisionDto,
  EvidenceDto,
  EvidencePageCursor,
  IntakeCandidatePage,
  IntakeCandidatePageCursor,
  RecapDto,
  ReplacementReview,
  StreamDto,
  WorkGraphDefaultsDto,
  WorkItemAttemptPageCursor,
  TaskActivityPage,
  TaskActivityPageCursor,
  StreamActivityGranularity,
  WorkItemDto,
  WorkSourceRevisionRef,
} from "@claxedo/workgraph/contracts"
import type { WorkGraphClient } from "../api"

/**
 * Narrow, strictly-typed data source for the Waiting panel and the focused item
 * dialogs. The UI depends on THIS interface — never on the raw snapshot — so the
 * strict Attention/detail endpoints are the only source of truth. When a backend
 * method is unavailable the adapter surfaces the real error; it never falls back
 * to reconstructing state from the full snapshot.
 */
export type WorkGraphWaitingSource = {
  /** One page of Attention items. Pass the previous page's `nextCursor` to page. */
  waiting: (after?: AttentionCursor) => Promise<AttentionPage>
  markAllRead: WorkGraphClient["markAllAttentionRead"]
  clear: WorkGraphClient["clearAttention"]
  proposal: (proposalId: string) => Promise<AdmissionProposalDto>
  workItem: (workItemId: string) => Promise<WorkItemDto>
  stream: (streamId: string) => Promise<StreamDto>
  /**
   * The true latest attempt for a Work Item — determined by following strict
   * page cursors to the end, so it is correct even beyond the first page.
   * Resolves to undefined when no attempt has run.
   */
  latestAttempt: (workItemId: string) => Promise<AttemptDetailDto | undefined>
  activity: (
    workItemId: string,
    options?: Readonly<{
      after?: TaskActivityPageCursor
      granularity?: StreamActivityGranularity
      limit?: number
    }>,
  ) => Promise<TaskActivityPage>
  evidence: (workItemId: string) => Promise<EvidenceDto[]>
  attempt: (attemptId: string) => Promise<AttemptDetailDto>
  decision: (decisionId: string) => Promise<DecisionDto>
  recap: (recapId: string) => Promise<RecapDto>
  /** One page of intake candidates. Pass the previous page's `nextCursor` to page. */
  candidates: (after?: IntakeCandidatePageCursor) => Promise<IntakeCandidatePage>
  defaults: () => Promise<WorkGraphDefaultsDto>
  answerDecision: (decisionId: string, expectedVersion: number, answer: { optionId?: string; answer?: string }) => Promise<CommandResult>
  dismissDecision: (decisionId: string, expectedVersion: number, reason: string) => Promise<CommandResult>
  markNotificationRead: (notificationId: string, expectedVersion: number) => Promise<unknown>
  confirmAdmission: (proposal: Parameters<WorkGraphClient["confirmAdmission"]>[0]) => Promise<CommandResult>
  dismissAdmission: (proposalId: string, expectedVersion: number) => Promise<CommandResult>
  stageIntakeCandidate: (candidateId: string) => Promise<unknown>
  dismissIntakeCandidate: (candidateId: string, expectedVersion: number) => Promise<unknown>
  cancelAttempt: (attemptId: string, expectedVersion: number, reason: string) => Promise<CommandResult>
  retryWorkItem: (workItemId: string, expectedVersion: number) => Promise<CommandResult>
  executeWorkItem: WorkGraphClient["executeWorkItem"]
  /**
   * Server-truth review for a Work Source *revision* admission (i.e. a proposal
   * whose `previousSource` is set). Returns the target Stream's title (needed to
   * fork) and the exact current nonterminal source-linked Tasks eligible for a
   * Replace, or a disabled status with a clear reason. The eligible set is never
   * reconstructed from the full snapshot or fabricated from LLM duplicate hints —
   * when the backend cannot supply the exact set the adapter surfaces it as an
   * explicit, non-eligible status.
   */
  replacementReview: (input: Readonly<{ streamId: string; previousSource: WorkSourceRevisionRef }>) => Promise<ReplacementReview>
}

/** Adapts the transport client to the Waiting UI's typed data source. */
export function waitingSourceFromClient(client: WorkGraphClient): WorkGraphWaitingSource {
  return {
    waiting: (after) => client.attention(after),
    markAllRead: () => client.markAllAttentionRead(),
    clear: () => client.clearAttention(),
    proposal: (id) => client.proposal(id),
    workItem: (id) => client.workItem(id),
    stream: (id) => client.stream(id),
    latestAttempt: (id) => latestAttempt(client, id),
    activity: (id, options) => client.workItemActivity(id, options),
    evidence: (id) => workItemEvidence(client, id),
    attempt: (id) => client.attempt(id),
    decision: (id) => client.decision(id),
    recap: (id) => client.recap(id),
    candidates: (after) => client.intakeCandidates(after ? { after } : {}),
    defaults: () => client.defaults(),
    answerDecision: (id, version, answer) => client.answerDecision(id, version, answer),
    dismissDecision: (id, version, reason) => client.dismissDecision(id, version, reason),
    markNotificationRead: (id, version) => client.markNotificationRead(id, version),
    confirmAdmission: (proposal) => client.confirmAdmission(proposal),
    dismissAdmission: (id, version) => client.dismissAdmission(id, version),
    stageIntakeCandidate: (id) => client.stageIntakeCandidate(id),
    dismissIntakeCandidate: (id, version) => client.dismissIntakeCandidate(id, version),
    cancelAttempt: (id, version, reason) => client.cancelAttempt(id, version, reason),
    retryWorkItem: (id, version) => client.retryWorkItem(id, version),
    executeWorkItem: (id, mode) => client.executeWorkItem(id, mode),
    replacementReview: (input) => client.replacementReview(input),
  }
}

/**
 * Walks every attempt page in cursor order and returns the attempt with the
 * highest attempt number. Following the cursor to the end (rather than reading
 * only the first page) is what makes "latest" correct when a Work Item has more
 * attempts than one page holds.
 */
async function latestAttempt(client: WorkGraphClient, workItemId: string) {
  let after: WorkItemAttemptPageCursor | undefined
  let best: AttemptDetailDto | undefined
  for (;;) {
    const page = await client.workItemAttempts(workItemId, after ? { after } : {})
    for (const detail of page.attempts) {
      if (!best || detail.attempt.attemptNumber > best.attempt.attemptNumber) best = detail
    }
    if (!page.hasMore || !page.nextCursor) return best
    after = page.nextCursor
  }
}

async function workItemEvidence(client: WorkGraphClient, workItemId: string) {
  const evidence: EvidenceDto[] = []
  let after: EvidencePageCursor | undefined
  for (;;) {
    const page = await client.evidencePage(
      { type: "work_item", workItemId },
      { limit: 100, ...(after ? { after } : {}) },
    )
    evidence.push(...page.evidence)
    if (!page.hasMore || !page.nextCursor) return evidence
    after = page.nextCursor
  }
}

export type WaitingKind = AttentionItem["kind"]

/** Compact, presentation-ready projection of one Attention item for a row. */
export type WaitingRowView = {
  key: string
  kind: WaitingKind
  /** Right-aligned monospace tag, e.g. "proposed", "pending", "blocked". */
  tag: string
  title: string
  meta: string
  /** Whether the leading dot should read as critical (coral) vs neutral. */
  critical: boolean
  item: AttentionItem
}

const WORK_ITEM_TAG: Record<string, string> = {
  blocked: "blocked",
  review_needed: "review needed",
  integration_needed: "integration",
  verification_failed: "verification failed",
}

/** Maps an Attention item to a row view. Pure — no fabricated values. */
export function toWaitingRow(item: AttentionItem): WaitingRowView {
  if (item.kind === "recap_notification") {
    return {
      key: `recap:${item.id}`,
      kind: item.kind,
      tag: "recap",
      title: "Actionable stream recap",
      meta: `${item.recap.actionableReferences.length} actionable ref${item.recap.actionableReferences.length === 1 ? "" : "s"}`,
      critical: false,
      item,
    }
  }
  if (item.kind === "admission_proposal") {
    const outcomes = item.record.state === "proposed" ? item.record.proposedOutcomes.length : 0
    const tasks = item.record.state === "proposed" ? item.record.proposedWorkItems.length : 0
    return {
      key: `proposal:${item.id}`,
      kind: item.kind,
      tag: "proposed",
      title: "Review proposed work",
      meta: `${tasks} task${tasks === 1 ? "" : "s"} · ${outcomes} outcome${outcomes === 1 ? "" : "s"} planned`,
      critical: false,
      item,
    }
  }
  if (item.kind === "decision") {
    return {
      key: `decision:${item.id}`,
      kind: item.kind,
      tag: "pending",
      title: item.record.question,
      meta: `Decision · ${item.record.options.length} option${item.record.options.length === 1 ? "" : "s"} · affects ${item.record.affectedWorkItemIds.length}`,
      critical: true,
      item,
    }
  }
  if (item.kind === "work_item") {
    return {
      key: `work_item:${item.id}`,
      kind: item.kind,
      tag: WORK_ITEM_TAG[item.record.state] ?? item.record.state.replaceAll("_", " "),
      title: item.record.title,
      meta: item.record.dependencyIds.length ? `waits for ${item.record.dependencyIds.length}` : "needs your review",
      critical: item.record.state === "blocked" || item.record.state === "verification_failed",
      item,
    }
  }
  if (item.kind === "attempt") {
    return {
      key: `attempt:${item.id}`,
      kind: item.kind,
      tag: "attention",
      title: `Attempt ${item.record.attemptNumber}`,
      meta: item.record.attentionReason ?? "Attempt needs your attention",
      critical: true,
      item,
    }
  }
  if (item.kind === "unorganized_ai_work") {
    return {
      key: "unorganized_ai_work",
      kind: item.kind,
      tag: `${item.counts.total} item${item.counts.total === 1 ? "" : "s"}`,
      title: "Unorganized AI work",
      meta: `${item.counts.total} candidate${item.counts.total === 1 ? "" : "s"} · ${item.counts.externalIssues} issue${item.counts.externalIssues === 1 ? "" : "s"} · ${item.counts.sessions} session${item.counts.sessions === 1 ? "" : "s"}`,
      critical: false,
      item,
    }
  }
  const requirement = item.requirement
  return {
    key: `configuration_required:${item.id}`,
    kind: item.kind,
    tag: "config",
    title: "Configuration required",
    meta:
      requirement.type === "connection"
        ? `${requirement.integrationId} connection ${requirement.status}${requirement.accountLabel ? ` · ${requirement.accountLabel}` : ""}`
        : `${requirement.purpose.replaceAll("_", " ")} generation needs attention`,
    critical: requirement.type === "connection" ? requirement.status === "broken" : true,
    item,
  }
}
