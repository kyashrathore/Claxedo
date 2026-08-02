import type {
  AdmissionProposalDto,
  RunDetailDto,
  AttentionCursor,
  AttentionItem,
  AttentionPage,
  CommandResult,
  DecisionDto,
  EvidenceDto,
  EvidencePageCursor,
  IntakeCandidatePage,
  IntakeCandidatePageCursor,
  ReplacementReview,
  StreamDto,
  WorkGraphDefaultsDto,
  WorkItemRunPageCursor,
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
   * The true latest run for a Work Item — determined by following strict
   * page cursors to the end, so it is correct even beyond the first page.
   * Resolves to undefined when no run has run.
   */
  latestRun: (workItemId: string) => Promise<RunDetailDto | undefined>
  activity: (
    workItemId: string,
    options?: Readonly<{
      after?: TaskActivityPageCursor
      granularity?: StreamActivityGranularity
      limit?: number
    }>,
  ) => Promise<TaskActivityPage>
  evidence: (workItemId: string) => Promise<EvidenceDto[]>
  run: (runId: string) => Promise<RunDetailDto>
  decision: (decisionId: string) => Promise<DecisionDto>
  /** One page of intake candidates. Pass the previous page's `nextCursor` to page. */
  candidates: (after?: IntakeCandidatePageCursor) => Promise<IntakeCandidatePage>
  defaults: () => Promise<WorkGraphDefaultsDto>
  answerDecision: (decisionId: string, expectedVersion: number, answer: { optionId?: string; answer?: string }) => Promise<CommandResult>
  dismissDecision: (decisionId: string, expectedVersion: number, reason: string) => Promise<CommandResult>
  confirmAdmission: (proposal: Parameters<WorkGraphClient["confirmAdmission"]>[0]) => Promise<CommandResult>
  confirmPublicPr: WorkGraphClient["confirmPublicPr"]
  dismissAdmission: (proposalId: string, expectedVersion: number) => Promise<CommandResult>
  stageIntakeCandidate: (candidateId: string) => Promise<unknown>
  dismissIntakeCandidate: (candidateId: string, expectedVersion: number) => Promise<unknown>
  cancelRun: (runId: string, expectedVersion: number, reason: string) => Promise<CommandResult>
  retryWorkItem: (workItemId: string, expectedVersion: number) => Promise<CommandResult>
  approveWorkItem: WorkGraphClient["approveWorkItem"]
  rejectWorkItem: WorkGraphClient["rejectWorkItem"]
  approveWorkItems: WorkGraphClient["approveWorkItems"]
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
    latestRun: (id) => latestRun(client, id),
    activity: (id, options) => client.workItemActivity(id, options),
    evidence: (id) => workItemEvidence(client, id),
    run: (id) => client.run(id),
    decision: (id) => client.decision(id),
    candidates: (after) => client.intakeCandidates(after ? { after } : {}),
    defaults: () => client.defaults(),
    answerDecision: (id, version, answer) => client.answerDecision(id, version, answer),
    dismissDecision: (id, version, reason) => client.dismissDecision(id, version, reason),
    confirmAdmission: (proposal) => client.confirmAdmission(proposal),
    confirmPublicPr: (id, version) => client.confirmPublicPr(id, version),
    dismissAdmission: (id, version) => client.dismissAdmission(id, version),
    stageIntakeCandidate: (id) => client.stageIntakeCandidate(id),
    dismissIntakeCandidate: (id, version) => client.dismissIntakeCandidate(id, version),
    cancelRun: (id, version, reason) => client.cancelRun(id, version, reason),
    retryWorkItem: (id, version) => client.retryWorkItem(id, version),
    approveWorkItem: (id, version) => client.approveWorkItem(id, version),
    rejectWorkItem: (id, version, reason) => client.rejectWorkItem(id, version, reason),
    approveWorkItems: (approvals) => client.approveWorkItems(approvals),
    replacementReview: (input) => client.replacementReview(input),
  }
}

/**
 * Walks every run page in cursor order and returns the run with the
 * highest run number. Following the cursor to the end (rather than reading
 * only the first page) is what makes "latest" correct when a Work Item has more
 * runs than one page holds.
 */
async function latestRun(client: WorkGraphClient, workItemId: string) {
  let after: WorkItemRunPageCursor | undefined
  let best: RunDetailDto | undefined
  for (;;) {
    const page = await client.workItemRuns(workItemId, after ? { after } : {})
    for (const detail of page.runs) {
      if (!best || detail.run.runNumber > best.run.runNumber) best = detail
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
  /** A staged work item (pending_approval): rendered with inline Approve/Reject
   *  and a dashed glyph, visually distinct from result-review rows. */
  staged: boolean
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
      staged: false,
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
      staged: false,
      item,
    }
  }
  if (item.kind === "work_item") {
    const staged = item.record.state === "pending_approval"
    return {
      key: `work_item:${item.id}`,
      kind: item.kind,
      tag: staged ? "staged" : (WORK_ITEM_TAG[item.record.state] ?? item.record.state.replaceAll("_", " ")),
      title: item.record.title,
      meta: staged
        ? "Approve to run"
        : item.record.dependencyIds.length
          ? `waits for ${item.record.dependencyIds.length}`
          : "needs your review",
      critical: item.record.state === "blocked" || item.record.state === "verification_failed",
      staged,
      item,
    }
  }
  if (item.kind === "run") {
    return {
      key: `run:${item.id}`,
      kind: item.kind,
      tag: "attention",
      title: `Run ${item.record.runNumber}`,
      meta: item.record.parkedReason ?? "Run needs your attention",
      critical: true,
      staged: false,
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
      staged: false,
      item,
    }
  }
  if (item.kind === "master_escalation") {
    return {
      key: `master_escalation:${item.id}`,
      kind: item.kind,
      tag: "master",
      title: "Master needs your help",
      meta: item.reason,
      critical: true,
      staged: false,
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
    staged: false,
    item,
  }
}
