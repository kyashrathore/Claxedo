import type {
  AttemptDetailDto,
  AttentionItem,
  IntakeCandidateDto,
  IntakeCandidatePageCursor,
  ResolvedExecutionProfile,
} from "@claxedo/workgraph/contracts"
import { Button } from "@opencode-ai/ui/button"
import { createMemo, createResource, createSignal, For, type JSX, onMount, Show } from "solid-js"
import { ActionError, createAction } from "./dialog-action"
import { ProposalContent } from "./item-dialog-proposal"
import type { WorkGraphWaitingSource } from "./waiting-source"
import { DetailState, DialogField, DialogSection, WorkGraphDialog } from "./workgraph-dialog"

type Selection = AttentionItem | undefined
type SessionReference = { sessionId: string; workspaceId?: string }

/**
 * Opens a focused dialog over the WorkGraph screen for the selected Waiting
 * item. Opening never resolves the item; it only leaves Waiting after its real
 * domain transition succeeds (except an actionable Recap notification, which
 * becomes read once the Recap is actually opened).
 */
type ItemContentProps = {
  item: AttentionItem
  source: WorkGraphWaitingSource
  onResolved: () => void
  onClose: () => void
  /** Opens the shared WorkGraph settings panel tab (for configuration_required). */
  onOpenSettings?: () => void
  onOpenSession?: (reference: SessionReference) => void
}

export function WaitingItemDialog(props: {
  selection: Selection
  source: WorkGraphWaitingSource
  onClose: () => void
  /** Called after a real domain transition so the caller can refetch Waiting. */
  onResolved: () => void
  /** Opens the shared WorkGraph settings panel tab (for configuration_required). */
  onOpenSettings?: () => void
  /** Opens an execution Session through the app shell's canonical Session route. */
  onOpenSession?: (reference: SessionReference) => void
}) {
  const openSession = (reference: SessionReference) => {
    props.onClose()
    props.onOpenSession?.(reference)
  }
  const retryAction = createAction(() => {
    props.onResolved()
    props.onClose()
  })
  const retryableTask = createMemo(() => {
    const selection = props.selection
    if (selection?.kind !== "work_item") return
    if (selection.record.state !== "failed" && selection.record.state !== "verification_failed") return
    return selection.record
  })
  const footer = createMemo<JSX.Element | undefined>(() => {
    const item = retryableTask()
    if (!item) return
    return (
      <>
        <Show when={retryAction.error()}>
          {(message) => <span class="workgraph-dialog-footer-error" role="alert">{message()}</span>}
        </Show>
        <Button
          size="small"
          variant="primary"
          disabled={retryAction.busy()}
          onClick={() => void retryAction.run(() => props.source.retryWorkItem(item.id, item.version))}
        >
          {retryAction.busy() ? "Starting…" : "Run again"}
        </Button>
      </>
    )
  })
  const title = createMemo<JSX.Element>(() => {
    const kind = props.selection?.kind
    if (kind === "decision") return "Decision"
    if (kind === "admission_proposal") return "Review proposed work"
    if (kind === "work_item") return "Task"
    if (kind === "attempt") return "Attempt"
    if (kind === "recap_notification") return "Recap"
    if (kind === "unorganized_ai_work") return "Unorganized AI work"
    if (kind === "configuration_required") return "Configuration required"
    return "Waiting"
  })

  return (
    <WorkGraphDialog open={!!props.selection} onClose={props.onClose} title={title()} size="large" scrollBody footer={footer()}>
      <Show when={props.selection} keyed>
        {(item) => (
          <Show when={item.kind === "decision" && item} keyed fallback={<NonDecision item={item} source={props.source} onResolved={props.onResolved} onClose={props.onClose} onOpenSettings={props.onOpenSettings} onOpenSession={props.onOpenSession ? openSession : undefined} />}>
            {(decision) => <DecisionContent item={decision} source={props.source} onResolved={props.onResolved} onClose={props.onClose} />}
          </Show>
        )}
      </Show>
    </WorkGraphDialog>
  )
}

function NonDecision(props: ItemContentProps) {
  return (
    <Show when={props.item.kind === "admission_proposal" && props.item} keyed fallback={<AfterProposal {...props} />}>
      {(item) => <ProposalContent item={item} source={props.source} onResolved={props.onResolved} onClose={props.onClose} />}
    </Show>
  )
}

function AfterProposal(props: ItemContentProps) {
  return (
    <Show when={props.item.kind === "work_item" && props.item} keyed fallback={<AfterWorkItem {...props} />}>
      {(item) => <TaskContent item={item} source={props.source} onOpenSession={props.onOpenSession} />}
    </Show>
  )
}

function AfterWorkItem(props: ItemContentProps) {
  return (
    <Show when={props.item.kind === "attempt" && props.item} keyed fallback={<AfterAttempt {...props} />}>
      {(item) => <AttemptContent attemptId={item.record.id} source={props.source} onOpenSession={props.onOpenSession} />}
    </Show>
  )
}

function AfterAttempt(props: ItemContentProps) {
  return (
    <Show when={props.item.kind === "recap_notification" && props.item} keyed fallback={<AfterRecap {...props} />}>
      {(item) => <RecapContent item={item} source={props.source} onResolved={props.onResolved} />}
    </Show>
  )
}

function AfterRecap(props: ItemContentProps) {
  return (
    <Show when={props.item.kind === "unorganized_ai_work"} fallback={<ConfigRequiredContent item={props.item} onOpenSettings={props.onOpenSettings} onClose={props.onClose} />}>
      <CandidatesContent source={props.source} onResolved={props.onResolved} />
    </Show>
  )
}

// ── Decision ──────────────────────────────────────────────────────────────

function DecisionContent(props: {
  item: Extract<AttentionItem, { kind: "decision" }>
  source: WorkGraphWaitingSource
  onResolved: () => void
  onClose: () => void
}) {
  const [detail, { refetch }] = createResource(() => props.source.decision(props.item.record.id))
  const action = createAction(() => {
    props.onResolved()
    props.onClose()
  })
  const [answer, setAnswer] = createSignal("")
  return (
    <DetailState resource={detail} retry={refetch}>
      {(decision) => (
        <div class="workgraph-detail">
          <p class="workgraph-detail-lede text-text-strong">{decision.question}</p>
          <Show when={decision.rationale}>
            <p class="text-[12px] leading-5 text-text-base">{decision.rationale}</p>
          </Show>
          <DialogSection title="Options">
            <div class="workgraph-detail-options">
              <For each={decision.options}>
                {(option) => (
                  <Button
                    size="small"
                    variant={option.id === decision.recommendationOptionId ? "primary" : "secondary"}
                    disabled={action.busy()}
                    onClick={() => void action.run(() => props.source.answerDecision(decision.id, decision.version, { optionId: option.id }))}
                  >
                    {option.label}
                    <Show when={option.id === decision.recommendationOptionId}> · recommended</Show>
                  </Button>
                )}
              </For>
            </div>
          </DialogSection>
          <DialogSection title="Or answer directly">
            <div class="workgraph-detail-answer">
              <input
                class="workgraph-input"
                value={answer()}
                placeholder="Write a different answer"
                onInput={(event) => setAnswer(event.currentTarget.value)}
              />
              <Button
                size="small"
                variant="secondary"
                disabled={!answer().trim() || action.busy()}
                onClick={() => void action.run(() => props.source.answerDecision(decision.id, decision.version, { answer: answer().trim() }))}
              >
                Answer
              </Button>
            </div>
          </DialogSection>
          <DialogField label="Affects">{decision.affectedWorkItemIds.length} task(s)</DialogField>
          <ActionError message={action.error()} />
          <div class="workgraph-detail-actions">
            <Button
              size="small"
              variant="ghost"
              disabled={action.busy()}
              onClick={() => void action.run(() => props.source.dismissDecision(decision.id, decision.version, "Dismissed from Waiting"))}
            >
              Dismiss decision
            </Button>
          </div>
        </div>
      )}
    </DetailState>
  )
}

// ── Task (work item) + Attempt execution/results ──────────────────────────

function TaskContent(props: {
  item: Extract<AttentionItem, { kind: "work_item" }>
  source: WorkGraphWaitingSource
  onOpenSession?: (reference: SessionReference) => void
}) {
  const [workItem, { refetch }] = createResource(() => props.source.workItem(props.item.record.id))
  // The true latest attempt, resolved by following strict page cursors to the
  // end — never an arbitrary first-page attempt.
  const [latest] = createResource(() => props.source.latestAttempt(props.item.record.id))
  return (
    <DetailState resource={workItem} retry={refetch}>
      {(item) => (
        <div class="workgraph-detail">
          <p class="workgraph-detail-lede text-text-strong">{item.title}</p>
          <DialogField label="State">{item.state.replaceAll("_", " ")}</DialogField>
          <Show when={item.dependencyIds.length}>
            <DialogField label="Waits for">{item.dependencyIds.length} task(s)</DialogField>
          </Show>
          <DialogSection title="Completion requirements">
            <For each={item.completionContract.requirements}>
              {(requirement) => (
                <div class="workgraph-detail-plan-item">
                  <span class="text-text-base">{requirement.kind.replaceAll("_", " ")}</span>
                  <span class="text-[11px] text-text-base">{requirement.description}</span>
                </div>
              )}
            </For>
          </DialogSection>
          <DialogSection title="Latest attempt">
            <Show when={latest.loading && !latest()}>
              <div class="workgraph-detail-status" role="status">
                Loading attempt…
              </div>
            </Show>
            <Show when={latest.error}>
              <div class="workgraph-detail-status is-error" role="alert">
                {String((latest.error as { message?: string })?.message ?? "Attempts could not be loaded.")}
              </div>
            </Show>
            <Show when={latest()} fallback={<Show when={!latest.loading && !latest.error}><span class="text-[12px] text-text-weaker">No attempt has run yet.</span></Show>}>
              {(detail) => <AttemptDetailView detail={detail()} onOpenSession={props.onOpenSession} />}
            </Show>
          </DialogSection>
        </div>
      )}
    </DetailState>
  )
}

function AttemptContent(props: { attemptId: string; source: WorkGraphWaitingSource; onOpenSession?: (reference: SessionReference) => void }) {
  const [detail, { refetch }] = createResource(() => props.source.attempt(props.attemptId))
  return (
    <DetailState resource={detail} retry={refetch}>
      {(attemptDetail) => (
        <div class="workgraph-detail">
          <AttemptDetailView detail={attemptDetail} onOpenSession={props.onOpenSession} />
        </div>
      )}
    </DetailState>
  )
}

/**
 * Renders an attempt's resolved execution + results. Deliberately omits any
 * credential-bearing field: no repository remote URL, no lease/control-plane
 * tokens, no secrets. Only safe Session/workspace references are shown.
 */
function AttemptDetailView(props: { detail: AttemptDetailDto; onOpenSession?: (reference: SessionReference) => void }) {
  const attempt = () => props.detail.attempt
  const exec = (): ResolvedExecutionProfile => attempt().resolvedExecution
  const references = () => props.detail.executionReferences
  return (
    <div class="workgraph-detail-grid">
      <DialogField label="Attempt">#{attempt().attemptNumber} · {attempt().state}</DialogField>
      <Show when={attempt().attentionReason}>
        {(reason) => (
          <div class="workgraph-attempt-error" role="alert">
            <span class="text-[11px] font-semibold">{attempt().state === "failed" ? "Attempt failed" : "Attempt needs attention"}</span>
            <span class="text-[12px] leading-5">{reason()}</span>
          </div>
        )}
      </Show>
      <DialogField label="Environment">
        {exec().environment.kind.replaceAll("_", " ")}
        <Show when={exec().environment.presetId}> · {exec().environment.presetId}</Show>
      </DialogField>
      <DialogField label="Model">{exec().model.providerId}/{exec().model.modelId}</DialogField>
      <DialogField label="Effort">{exec().effort}</DialogField>
      <DialogField label="Agent">{exec().agent}</DialogField>
      <DialogField label="Harness">{exec().harness}</DialogField>
      <Show when={exec().repository?.baseRevision}>
        <DialogField label="Base revision" mono>{exec().repository!.baseRevision}</DialogField>
      </Show>
      <DialogField label="Tools">{exec().tools.length ? exec().tools.join(", ") : "none"}</DialogField>
      <DialogField label="Connections">{exec().connectionIds.length ? exec().connectionIds.join(", ") : "none"}</DialogField>
      <Show when={references()?.sessionId}>
        {(sessionId) => (
          <DialogField label="Session" mono>
            <Show when={props.onOpenSession} fallback={sessionId()}>
              {(openSession) => (
                <button
                  type="button"
                  class="workgraph-session-link"
                  aria-label={`Open session ${sessionId()}`}
                  onClick={() => openSession()({ sessionId: sessionId(), ...(references()?.workspaceId ? { workspaceId: references()!.workspaceId } : {}) })}
                >
                  {sessionId()}
                </button>
              )}
            </Show>
          </DialogField>
        )}
      </Show>
      <Show when={references()?.workspaceId}>
        <DialogField label="Workspace" mono>{references()!.workspaceId}</DialogField>
      </Show>
      <Show when={references()?.childWorkspaceId}>
        <DialogField label="Child workspace" mono>{references()!.childWorkspaceId}</DialogField>
      </Show>
      <Show when={attempt().result}>
        {(result) => (
          <div class="workgraph-detail-result">
            <span class="workgraph-dfield-label text-text-weaker">Result</span>
            <p class="text-[12px] leading-5 text-text-base">{result().summary}</p>
            <Show when={result().artifactRefs.length}>
              <ul class="workgraph-detail-artifacts">
                <For each={result().artifactRefs}>{(ref) => <li class="font-mono text-[11px] text-text-weaker">{ref}</li>}</For>
              </ul>
            </Show>
          </div>
        )}
      </Show>
    </div>
  )
}

// ── Recap ─────────────────────────────────────────────────────────────────

function RecapContent(props: {
  item: Extract<AttentionItem, { kind: "recap_notification" }>
  source: WorkGraphWaitingSource
  onResolved: () => void
}) {
  const [detail, { refetch }] = createResource(() => props.source.recap(props.item.recap.id))
  // Opening the Recap is what marks its notification read; the referenced
  // unresolved records remain separate attention. A failed mark-read leaves the
  // recap in Waiting and surfaces explicitly — it is not swallowed.
  const [read] = createResource(async () => {
    await props.source.markNotificationRead(props.item.notification.id, props.item.notification.version)
    props.onResolved()
    return true
  })
  return (
    <DetailState resource={detail} retry={refetch}>
      {(recap) => (
        <div class="workgraph-detail">
          <Show when={read.error}>
            <p class="workgraph-detail-status is-error" role="alert">
              {`Couldn't mark this recap read: ${String((read.error as { message?: string })?.message ?? read.error)}`}
            </p>
          </Show>
          <p class="text-[13px] leading-6 text-text-base">{recap.summary}</p>
          <DialogSection title={`Actionable references (${recap.actionableReferences.length})`}>
            <For each={recap.actionableReferences}>
              {(reference) => (
                <div class="workgraph-detail-plan-item font-mono text-[11px] text-text-weaker">
                  {reference.type.replaceAll("_", " ")} · {reference.id}
                </div>
              )}
            </For>
          </DialogSection>
          <DialogField label="Generation">{recap.generation.state}</DialogField>
        </div>
      )}
    </DetailState>
  )
}

// ── Unorganized AI work (candidates) ──────────────────────────────────────

function CandidatesContent(props: { source: WorkGraphWaitingSource; onResolved: () => void }) {
  const [candidates, setCandidates] = createSignal<IntakeCandidateDto[]>([])
  const [nextCursor, setNextCursor] = createSignal<IntakeCandidatePageCursor>()
  const [loading, setLoading] = createSignal(false)
  const [loaded, setLoaded] = createSignal(false)
  const [loadError, setLoadError] = createSignal<string>()
  // Pages explicitly via nextCursor. The first load and every post-action reload
  // fetch page one; "Load more" appends the next page — nothing is loaded eagerly.
  const load = async (after?: IntakeCandidatePageCursor) => {
    if (loading()) return
    setLoading(true)
    setLoadError()
    try {
      const page = await props.source.candidates(after)
      setCandidates((prev) => (after ? [...prev, ...page.candidates] : page.candidates))
      setNextCursor(page.hasMore ? page.nextCursor : undefined)
      setLoaded(true)
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }
  onMount(() => void load())
  const action = createAction(() => {
    props.onResolved()
    void load()
  })
  return (
    <div class="workgraph-detail">
      <ActionError message={action.error() ?? loadError()} />
      <Show when={loading() && !loaded()}>
        <div class="workgraph-detail-status" role="status" aria-live="polite">
          Loading…
        </div>
      </Show>
      <Show when={loaded() && !loading() && candidates().length === 0}>
        <div class="workgraph-detail-status">No unorganized AI work.</div>
      </Show>
      <For each={candidates()}>
        {(candidate) => (
          <div class="workgraph-detail-candidate">
            <div class="min-w-0">
              <div class="text-[12px] text-text-base">
                {candidate.candidateKind === "external_issue" && candidate.externalKey ? `${candidate.externalKey} · ` : ""}
                {candidate.title}
              </div>
              <div class="text-[11px] text-text-weaker">
                {candidate.candidateKind === "external_issue" ? `${candidate.provider} · ${candidate.externalStatus}` : "AI session"} · {candidate.state}
              </div>
            </div>
            <div class="flex flex-shrink-0 gap-1.5">
              <Show when={candidate.state === "unorganized"}>
                <Button size="small" variant="secondary" disabled={action.busy()} onClick={() => void action.run(() => props.source.stageIntakeCandidate(candidate.id))}>
                  Add to WorkGraph
                </Button>
                <Button size="small" variant="ghost" disabled={action.busy()} onClick={() => void action.run(() => props.source.dismissIntakeCandidate(candidate.id, candidate.version))}>
                  Dismiss
                </Button>
              </Show>
            </div>
          </div>
        )}
      </For>
      <Show when={nextCursor()}>
        {(cursor) => (
          <button type="button" class="workgraph-detail-retry" disabled={loading()} onClick={() => void load(cursor())}>
            {loading() ? "Loading…" : "Load more"}
          </button>
        )}
      </Show>
    </div>
  )
}

// ── Configuration required ────────────────────────────────────────────────

function ConfigRequiredContent(props: { item: AttentionItem; onOpenSettings?: () => void; onClose?: () => void }) {
  return (
    <Show when={props.item.kind === "configuration_required" && props.item} keyed>
      {(item) => (
        <Show
          when={item.requirement.type === "connection" && item.requirement}
          keyed
          fallback={
            <Show when={item.requirement.type === "generation" && item.requirement} keyed>
              {(requirement) => (
                <div class="workgraph-detail">
                  <p class="workgraph-detail-lede text-text-strong">Background work needs configuration</p>
                  <DialogField label="Purpose">{requirement.purpose.replaceAll("_", " ")}</DialogField>
                  <DialogField label="Reason">{requirement.reason}</DialogField>
                  <DialogField label="Job" mono>{requirement.jobId}</DialogField>
                  <p class="text-[12px] leading-5 text-text-weak">Open WorkGraph settings to configure the execution and recap defaults this background work needs.</p>
                  <Show when={props.onOpenSettings}>
                    <div class="workgraph-detail-actions">
                      <Button
                        size="small"
                        variant="primary"
                        onClick={() => {
                          props.onOpenSettings?.()
                          props.onClose?.()
                        }}
                      >
                        Open WorkGraph settings
                      </Button>
                    </div>
                  </Show>
                </div>
              )}
            </Show>
          }
        >
          {(requirement) => (
            <div class="workgraph-detail">
              <p class="workgraph-detail-lede text-text-strong">A connection needs attention</p>
              <DialogField label="Integration">{requirement.integrationId}</DialogField>
              <DialogField label="Status">{requirement.status}</DialogField>
              <Show when={requirement.accountLabel}>
                <DialogField label="Account">{requirement.accountLabel}</DialogField>
              </Show>
              <DialogField label="Connection" mono>{requirement.connectionId}</DialogField>
              <p class="text-[12px] leading-5 text-text-weak">
                Reconnect this integration from Connections settings to clear this item. Configuration lives outside WorkGraph, so it is not changed here.
              </p>
            </div>
          )}
        </Show>
      )}
    </Show>
  )
}
