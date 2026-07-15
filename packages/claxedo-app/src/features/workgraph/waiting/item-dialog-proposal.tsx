import type { AdmissionProposalDto, AttentionItem, WorkSourceRevisionRef } from "@claxedo/workgraph/contracts"
import { Button } from "@opencode-ai/ui/button"
import { createResource, For, Show } from "solid-js"
import { ActionError, createAction } from "./dialog-action"
import type { WorkGraphWaitingSource } from "./waiting-source"
import { DetailState, DialogField, DialogSection } from "./workgraph-dialog"

export function ProposalContent(props: {
  item: Extract<AttentionItem, { kind: "admission_proposal" }>
  source: WorkGraphWaitingSource
  onResolved: () => void
  onClose: () => void
}) {
  const [detail, { refetch }] = createResource(() => props.source.proposal(props.item.record.id))
  const action = createAction(() => {
    props.onResolved()
    props.onClose()
  })
  return (
    <DetailState resource={detail} retry={refetch}>
      {(proposal) => (
        <Show
          when={proposal.state === "proposed" && proposal}
          keyed
          fallback={<div class="workgraph-detail-status">This proposal is {proposal.state.replaceAll("_", " ")} and no longer reviewable.</div>}
        >
          {(reviewable) => (
            <div class="workgraph-detail">
              {/* A revision (previousSource present) needs an explicit Keep/Replace/Fork
                  choice; a first admission keeps its explicit Confirm. */}
              <Show
                when={reviewable.previousSource}
                keyed
                fallback={
                  <DialogField label="Placement">
                    {reviewable.suggestedPlacement.mode === "new_stream"
                      ? `New stream · ${reviewable.suggestedPlacement.streamTitle}`
                      : `Existing stream · ${reviewable.suggestedPlacement.streamId}`}
                  </DialogField>
                }
              >
                {(previousSource) => <SourceRevisionContext previousSource={previousSource} source={reviewable.source} diffSummary={reviewable.diffSummary} />}
              </Show>
              <ProposalPlan proposal={reviewable} />
              <ActionError message={action.error()} />
              <Show
                when={reviewable.previousSource}
                keyed
                fallback={
                  <div class="workgraph-detail-actions">
                    <Button
                      size="small"
                      variant="ghost"
                      disabled={action.busy()}
                      onClick={() => void action.run(() => props.source.dismissAdmission(reviewable.id, reviewable.version))}
                    >
                      Dismiss
                    </Button>
                    <Button
                      size="small"
                      variant="primary"
                      disabled={action.busy()}
                      onClick={() => void action.run(() => props.source.confirmAdmission(confirmAsProposed(reviewable)))}
                    >
                      Confirm
                    </Button>
                  </div>
                }
              >
                {(previousSource) => <RevisionActions reviewable={reviewable} previousSource={previousSource} source={props.source} action={action} />}
              </Show>
            </div>
          )}
        </Show>
      )}
    </DetailState>
  )
}

type ReviewableProposal = Extract<AdmissionProposalDto, { state: "proposed" }>
type ConfirmAdmissionInput = Parameters<WorkGraphWaitingSource["confirmAdmission"]>[0]
type AdmissionSelectionInput = ConfirmAdmissionInput["selection"]

/** Renders the exact prior/new source revision context for a revised Work Source. */
function SourceRevisionContext(props: { previousSource: WorkSourceRevisionRef; source: WorkSourceRevisionRef; diffSummary?: string }) {
  return (
    <>
      <p class="workgraph-detail-lede text-text-strong">This Work Source was revised</p>
      <DialogField label="Previous revision" mono>{props.previousSource.revisionId}</DialogField>
      <DialogField label="New revision" mono>{props.source.revisionId}</DialogField>
      <Show when={props.diffSummary}>
        {(summary) => (
          <DialogSection title="What changed">
            <p class="text-[12px] leading-5 text-text-weak">{summary()}</p>
          </DialogSection>
        )}
      </Show>
    </>
  )
}

/** The proposed additions (outcomes, tasks, possible duplicates) — shared by both dispositions. */
function ProposalPlan(props: { proposal: ReviewableProposal }) {
  return (
    <>
      <DialogSection title={`Outcomes (${props.proposal.proposedOutcomes.length})`}>
        <For each={props.proposal.proposedOutcomes} fallback={<span class="text-[12px] text-text-weaker">No outcomes proposed.</span>}>
          {(outcome) => (
            <div class="workgraph-detail-plan-item">
              <span class="text-text-base">{outcome.title}</span>
              <span class="text-[11px] text-text-base">{outcome.successCriteria.join(" · ")}</span>
            </div>
          )}
        </For>
      </DialogSection>
      <DialogSection title={`Tasks (${props.proposal.proposedWorkItems.length})`}>
        <For each={props.proposal.proposedWorkItems} fallback={<span class="text-[12px] text-text-weaker">No tasks proposed.</span>}>
          {(workItem) => <div class="workgraph-detail-plan-item text-text-base">{workItem.title}</div>}
        </For>
      </DialogSection>
      <Show when={props.proposal.duplicateMatches.length}>
        <DialogSection title={`Possible duplicates (${props.proposal.duplicateMatches.length})`}>
          <For each={props.proposal.duplicateMatches}>
            {(match) => (
              <div class="workgraph-detail-plan-item">
                <span class="text-text-base">{match.title}</span>
                <span class="text-[11px] text-text-base">{match.reason}</span>
              </div>
            )}
          </For>
        </DialogSection>
      </Show>
    </>
  )
}

/**
 * The Keep / Replace / Fork disposition for a revised Work Source. Nothing is
 * auto-confirmed: each choice is an explicit click submitting the exact server
 * contract. Replace shows and submits the exact reviewed current nonterminal
 * source-linked Tasks and stays disabled with a clear reason whenever the exact
 * eligible target set is missing, empty, stale, unrelated, durable, or otherwise
 * unavailable — the dialog never fabricates a target set.
 */
function RevisionActions(props: {
  reviewable: ReviewableProposal
  previousSource: WorkSourceRevisionRef
  source: WorkGraphWaitingSource
  action: ReturnType<typeof createAction>
}) {
  const streamId = () => (props.reviewable.suggestedPlacement.mode === "existing" ? props.reviewable.suggestedPlacement.streamId : undefined)
  const [review, { refetch }] = createResource(streamId, (id) => props.source.replacementReview({ streamId: id, previousSource: props.previousSource }))
  const busy = () => props.action.busy()
  const dispose = (selection: AdmissionSelectionInput) =>
    void props.action.run(() => props.source.confirmAdmission({ ...admissionAdditions(props.reviewable), selection }))
  // Reading an errored resource re-throws, so gate every read on review.error;
  // the error is surfaced explicitly below with a Retry instead.
  const forkTitle = () => {
    if (review.error) return undefined
    const title = review()?.streamTitle.trim()
    return title ? title : undefined
  }
  const eligibleTargets = () => {
    if (review.error) return undefined
    const current = review()
    return current && current.status === "eligible" && current.targets.length > 0 ? current.targets : undefined
  }
  const replaceReason = () => {
    if (review.error) return undefined
    const current = review()
    if (!current) return undefined
    if (current.status === "eligible") return current.targets.length > 0 ? undefined : "No source-linked Tasks remain to replace."
    return current.reason
  }
  return (
    <Show
      when={streamId()}
      keyed
      fallback={
        <div class="workgraph-detail-actions">
          <p class="workgraph-detail-status">This revision has no target Stream, so it cannot be kept, replaced, or forked.</p>
          <Button
            size="small"
            variant="ghost"
            disabled={busy()}
            onClick={() => void props.action.run(() => props.source.dismissAdmission(props.reviewable.id, props.reviewable.version))}
          >
            Dismiss
          </Button>
        </div>
      }
    >
      {(id) => (
        <>
          <Show when={review.loading && !review()}>
            <div class="workgraph-detail-status" role="status" aria-live="polite">
              Loading replacement review…
            </div>
          </Show>
          <Show when={review.error}>
            <div class="workgraph-detail-status is-error" role="alert">
              <span>{String((review.error as { message?: string })?.message ?? "Replacement review could not be loaded.")}</span>
              <button type="button" class="workgraph-detail-retry" onClick={refetch}>
                Retry
              </button>
            </div>
          </Show>
          <Show when={eligibleTargets()} keyed>
            {(targets) => (
              <DialogSection title={`Replaces (${targets.length})`}>
                <For each={targets}>
                  {(target) => (
                    <div class="workgraph-detail-plan-item">
                      <span class="text-text-base">{target.title}</span>
                      <span class="text-[11px] text-text-base">{target.state.replaceAll("_", " ")} · {target.workItemId}</span>
                    </div>
                  )}
                </For>
              </DialogSection>
            )}
          </Show>
          <Show when={replaceReason()}>
            {(reason) => (
              <p class="workgraph-detail-status" role="note">
                {reason()}
              </p>
            )}
          </Show>
          <div class="workgraph-detail-actions">
            <Button
              size="small"
              variant="ghost"
              disabled={busy()}
              onClick={() => void props.action.run(() => props.source.dismissAdmission(props.reviewable.id, props.reviewable.version))}
            >
              Dismiss
            </Button>
            <Button size="small" variant="secondary" disabled={busy()} onClick={() => dispose({ mode: "keep", streamId: id })}>
              Keep
            </Button>
            <Button
              size="small"
              variant="secondary"
              disabled={busy() || !forkTitle()}
              onClick={() => {
                const title = forkTitle()
                if (title) dispose({ mode: "fork", streamId: id, streamTitle: title })
              }}
            >
              Fork
            </Button>
            <Button
              size="small"
              variant="secondary"
              disabled={busy() || !eligibleTargets()}
              onClick={() => {
                const targets = eligibleTargets()
                if (targets) dispose({ mode: "replace", streamId: id, workItems: targets.map((target) => ({ workItemId: target.workItemId, expectedVersion: target.expectedVersion })) })
              }}
            >
              Replace
            </Button>
          </div>
        </>
      )}
    </Show>
  )
}

/**
 * The proposed additions (placement-independent) for a confirm-admission command:
 * the outcomes and work items the agent proposed, addressed by proposal identity
 * and version. Every value comes from the real proposal DTO — nothing is
 * fabricated. Callers supply the `selection` (create/existing/keep/replace/fork).
 */
function admissionAdditions(proposal: ReviewableProposal): Omit<ConfirmAdmissionInput, "selection"> {
  return {
    proposalId: proposal.id,
    expectedVersion: proposal.version,
    source: proposal.source,
    outcomes: proposal.proposedOutcomes.map((outcome) => ({
      proposalKey: outcome.key,
      title: outcome.title,
      ...(outcome.description ? { description: outcome.description } : {}),
      successCriteria: outcome.successCriteria,
      execution: outcome.execution,
    })),
    workItems: proposal.proposedWorkItems.map((workItem) => ({
      proposalKey: workItem.key,
      ...(workItem.outcomeKey ? { outcomeProposalKey: workItem.outcomeKey } : {}),
      title: workItem.title,
      ...(workItem.description ? { description: workItem.description } : {}),
      dependencyProposalKeys: workItem.dependencyKeys,
      completionContract: workItem.completionContract,
      execution: workItem.execution,
    })),
  }
}

/**
 * Builds a confirm-admission command that accepts a first admission exactly as
 * planned — the placement, outcomes, and work items the agent proposed. Every
 * value comes from the real proposal DTO; nothing is fabricated or hardcoded.
 */
function confirmAsProposed(proposal: ReviewableProposal): ConfirmAdmissionInput {
  return {
    ...admissionAdditions(proposal),
    selection:
      proposal.suggestedPlacement.mode === "new_stream"
        ? { mode: "create", streamTitle: proposal.suggestedPlacement.streamTitle }
        : { mode: "existing", streamId: proposal.suggestedPlacement.streamId },
  }
}
