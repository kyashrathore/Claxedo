import type {
  RunDto,
  AttentionItem,
  IntakeCandidateDto,
  IntakeCandidatePageCursor,
  StreamActivityGranularity,
  StreamMasterStatus,
  TaskActivityEntry,
  TaskActivityPageCursor,
  WorkItemDto,
} from "@claxedo/workgraph/contracts"
import { Button } from "@opencode-ai/ui/button"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { createMemo, createResource, createSignal, For, type JSX, onMount, Show } from "solid-js"
import { ActionError, createAction } from "./dialog-action"
import { ProposalContent } from "./item-dialog-proposal"
import type { WorkGraphWaitingSource } from "./waiting-source"
import { DetailState, DialogField, DialogSection, WorkGraphDialog } from "./workgraph-dialog"
import type { WorkGraphSessionOpener, WorkGraphSessionReference } from "../api"
import { createDependencyResolver, STATUS_DISPLAY, taskStatusLabel, type TaskStatusLabel } from "../work-item-rows"
import { MasterEscalationContent } from "./master-escalation-content"
import { RunDetailView } from "./run-detail-view"

/** Read-only status line for an approved `pending` task: Ready (will run /
 *  paused) when launchable, else Waiting on the named incomplete blockers. */
function pendingStatusText(
  item: WorkItemDto,
  depsComplete: boolean | undefined,
  streamPaused: boolean | undefined,
  incompleteDependencies: { id: string; title: string }[] | undefined,
): string {
  if (depsComplete ?? item.dependencyIds.length === 0) {
    return streamPaused ? "Ready — paused" : "Ready — will run automatically"
  }
  const count = incompleteDependencies?.length ?? item.dependencyIds.length
  const base = `Waiting on ${count} dependenc${count === 1 ? "y" : "ies"}`
  const titles = incompleteDependencies?.map((dep) => dep.title).join(", ")
  return titles ? `${base}: ${titles}` : base
}

type Selection = AttentionItem | undefined

export function TaskDialog(props: {
  item: WorkItemDto | undefined
  source: WorkGraphWaitingSource
  onClose: () => void
  onResolved: () => void
  onOpenSession?: WorkGraphSessionOpener
  refreshToken?: string
  activityGranularity?: StreamActivityGranularity
  /** Every non-abandoned task in the item's Stream — used to split Waiting vs
   *  Ready and to name the incomplete blockers a Waiting task is held on. */
  streamItems?: WorkItemDto[]
  streamRuns?: RunDto[]
  /** Whether the owning Stream is paused (an approved task reads "Ready — paused"). */
  streamPaused?: boolean
  masterStatus?: StreamMasterStatus
}) {
  const openSession = async (reference: WorkGraphSessionReference) => {
    await props.onOpenSession?.(reference)
    props.onClose()
  }
  const action = createAction(() => {
    props.onResolved()
    props.onClose()
  })
  const [rejecting, setRejecting] = createSignal(false)
  const [reason, setReason] = createSignal("")
  const retryable = () => !!props.item && ["failed", "verification_failed"].includes(props.item.state)
  const staged = () => props.item?.state === "pending_approval"
  const depsComplete = () => {
    const item = props.item
    if (!item) return true
    if (!props.streamItems) return item.dependencyIds.length === 0
    return createDependencyResolver(props.streamItems)(item)
  }
  // The exact incomplete blockers, named — never a bare count the owner can't act on.
  const incompleteDependencies = () => {
    const item = props.item
    if (!item || !props.streamItems) return []
    const byId = new Map(props.streamItems.map((entry) => [entry.id, entry] as const))
    return item.dependencyIds.flatMap((id) => {
      const dep = byId.get(id)
      if (!dep || dep.state === "completed" || dep.state === "abandoned") return []
      return [{ id, title: dep.title }]
    })
  }
  const statusLabel = (): TaskStatusLabel | undefined =>
    props.item ? taskStatusLabel(props.item.state, depsComplete()) : undefined
  const footerError = () => (
    <Show when={action.error()}>
      {(message) => <span class="workgraph-dialog-footer-error" role="alert">{message()}</span>}
    </Show>
  )
  const footer = () => {
    const item = props.item
    if (!item) return
    if (staged()) {
      return (
        <>
          {footerError()}
          <Show
            when={rejecting()}
            fallback={
              <>
                <Button size="small" variant="ghost" disabled={action.busy()} onClick={() => setRejecting(true)}>Reject</Button>
                <Button size="small" variant="primary" disabled={action.busy()} onClick={() => void action.run(() => props.source.approveWorkItem(item.id, item.version))}>
                  {action.busy() ? "Approving…" : "Approve"}
                </Button>
              </>
            }
          >
            <input
              ref={(input) => requestAnimationFrame(() => input.isConnected && input.focus())}
              class="workgraph-input"
              aria-label="Reason to reject"
              value={reason()}
              placeholder="Reason to reject"
              disabled={action.busy()}
              onInput={(event) => setReason(event.currentTarget.value)}
            />
            <Button size="small" variant="primary" disabled={action.busy() || !reason().trim()} onClick={() => void action.run(() => props.source.rejectWorkItem(item.id, item.version, reason().trim()))}>
              {action.busy() ? "Rejecting…" : "Reject task"}
            </Button>
          </Show>
        </>
      )
    }
    if (!retryable()) return
    return (
      <>
        {footerError()}
        <Button size="small" variant="primary" disabled={action.busy()} onClick={() => void action.run(() => props.source.retryWorkItem(item.id, item.version))}>
          {action.busy() ? "Starting…" : "Run again"}
        </Button>
      </>
    )
  }
  return (
    <WorkGraphDialog open={!!props.item} onClose={props.onClose} title="Task" scrollBody footer={footer()}>
      <Show when={props.item} keyed>
        {(item) => (
          <TaskContent
            workItemId={item.id}
            refreshToken={props.refreshToken}
            activityGranularity={props.activityGranularity}
            source={props.source}
            statusLabel={statusLabel()}
            streamPaused={props.streamPaused}
            depsComplete={depsComplete()}
            incompleteDependencies={incompleteDependencies()}
            masterStatus={props.masterStatus}
            streamRuns={props.streamRuns}
            onOpenSession={openSession}
          />
        )}
      </Show>
    </WorkGraphDialog>
  )
}
type ItemContentProps = {
  item: AttentionItem
  source: WorkGraphWaitingSource
  onResolved: () => void
  onClose: () => void
  /** Opens the shared WorkGraph settings panel tab (for configuration_required). */
  onOpenSettings?: () => void
  onOpenSession?: WorkGraphSessionOpener
  activityGranularity?: StreamActivityGranularity
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
  onOpenSession?: WorkGraphSessionOpener
}) {
  const openSession = async (reference: WorkGraphSessionReference) => {
    await props.onOpenSession?.(reference)
    props.onClose()
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
    if (kind === "run") return "Run"
    if (kind === "unorganized_ai_work") return "Unorganized AI work"
    if (kind === "configuration_required") return "Configuration required"
    if (kind === "master_escalation") return "Master needs your help"
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
      {(item) => <TaskContent workItemId={item.record.id} source={props.source} onOpenSession={props.onOpenSession} />}
    </Show>
  )
}

function AfterWorkItem(props: ItemContentProps) {
  return (
    <Show when={props.item.kind === "run" && props.item} keyed fallback={<AfterRun {...props} />}>
      {(item) => <RunContent runId={item.record.id} source={props.source} onOpenSession={props.onOpenSession} />}
    </Show>
  )
}

function AfterRun(props: ItemContentProps) {
  return (
    <Show when={props.item.kind === "unorganized_ai_work"} fallback={<AfterCandidates {...props} />}>
      <CandidatesContent source={props.source} onResolved={props.onResolved} />
    </Show>
  )
}

function AfterCandidates(props: ItemContentProps) {
  return (
    <Show when={props.item.kind === "master_escalation" && props.item} keyed fallback={<ConfigRequiredContent item={props.item} onOpenSettings={props.onOpenSettings} onClose={props.onClose} />}>
      {(item) => <MasterEscalationContent item={item} source={props.source} onResolved={props.onResolved} onClose={props.onClose} onOpenSession={props.onOpenSession} />}
    </Show>
  )
}

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

// ── Task (work item) + Run execution/results ──────────────────────────

function TaskContent(props: {
  workItemId: string
  refreshToken?: string
  activityGranularity?: StreamActivityGranularity
  source: WorkGraphWaitingSource
  statusLabel?: TaskStatusLabel
  streamPaused?: boolean
  depsComplete?: boolean
  incompleteDependencies?: { id: string; title: string }[]
  masterStatus?: StreamMasterStatus
  streamRuns?: RunDto[]
  onOpenSession?: WorkGraphSessionOpener
}) {
  const [workItem, { refetch }] = createResource(
    () => [props.workItemId, props.refreshToken] as const,
    ([workItemId]) => props.source.workItem(workItemId),
  )
  const [stream, { refetch: refetchStream }] = createResource(
    () => props.activityGranularity ? undefined : workItem()?.streamId,
    (streamId) => props.source.stream(streamId),
  )
  const activityKey = createMemo(() => {
    const granularity = props.activityGranularity ?? stream()?.activityGranularity
    if (!granularity) return
    return { granularity, refreshToken: props.refreshToken ?? workItem()?.version }
  })
  // The true latest run, resolved by following strict page cursors to the
  // end — never an arbitrary first-page run.
  const [latest] = createResource(
    () => [props.workItemId, props.refreshToken] as const,
    ([workItemId]) => props.source.latestRun(workItemId),
  )
  return (
    <DetailState resource={workItem} retry={refetch} skeleton={<TaskSkeleton />}>
      {(item) => (
        <div class="workgraph-detail">
          <div class="workgraph-detail-head">
            <div class="flex items-center gap-2">
              <p class="workgraph-detail-title text-text-strong">{item.title}</p>
              <Show when={props.statusLabel}>
                {(label) => (
                  <span class="workgraph-detail-chip" data-status={label()}>
                    {label() === "ready" && props.streamPaused ? "Ready · paused" : STATUS_DISPLAY[label()]}
                  </span>
                )}
              </Show>
            </div>
            <Show when={item.description?.trim()}>
              <p class="workgraph-detail-desc text-text-weak">{item.description}</p>
            </Show>
          </div>
          {/* An approved-but-not-yet-running task is read-only: launch is
              automatic, so the inspector reports where it stands, no Run button. */}
          <Show when={item.state === "pending"}>
            <div class="workgraph-detail-status" role="status">{pendingStatusText(item, props.depsComplete, props.streamPaused, props.incompleteDependencies)}</div>
          </Show>
          <TaskChips item={item} source={props.source} />
          <DialogSection title="Latest run">
            <Show when={latest.loading && !latest()}>
              <div class="workgraph-detail-status" role="status">
                Loading run…
              </div>
            </Show>
            <Show when={latest.error}>
              <div class="workgraph-detail-status is-error" role="alert">
                {String((latest.error as { message?: string })?.message ?? "Runs could not be loaded.")}
              </div>
            </Show>
            <Show when={latest()} fallback={<Show when={!latest.loading && !latest.error}><span class="text-[12px] text-text-weaker">No run has run yet.</span></Show>}>
              {(detail) => <RunDetailView detail={detail()} masterStatus={props.masterStatus} streamRuns={props.streamRuns} onOpenSession={props.onOpenSession} />}
            </Show>
          </DialogSection>
          <Show when={activityKey()} keyed fallback={
            <DialogSection title="Activity">
              <Show when={!stream.error} fallback={<div class="workgraph-detail-status is-error" role="alert">Activity settings could not be loaded. <button type="button" class="workgraph-detail-retry" onClick={() => void refetchStream()}>Retry</button></div>}>
                <div class="workgraph-detail-status" role="status">Loading activity…</div>
              </Show>
            </DialogSection>
          }>
            {(key) => <TaskActivity workItemId={item.id} granularity={key.granularity} source={props.source} />}
          </Show>
        </div>
      )}
    </DetailState>
  )
}

/** Layout-shaped placeholder for the Task dialog: title bar, chip pills, and
 *  section lines pulse where the real content will land, instead of a bare
 *  "Loading…" in an otherwise empty dialog. */
function TaskSkeleton() {
  return (
    <div class="workgraph-detail" role="status" aria-live="polite" aria-label="Loading task">
      <div class="h-7 w-2/3 animate-pulse rounded-md bg-background-stronger motion-reduce:animate-none" />
      <div class="flex gap-1.5 border-t border-border-weak-base pt-3">
        <div class="h-7 w-24 animate-pulse rounded-md bg-background-stronger motion-reduce:animate-none" />
        <div class="h-7 w-48 animate-pulse rounded-md bg-background-stronger motion-reduce:animate-none" />
      </div>
      <div class="mt-2 h-4 w-1/2 animate-pulse rounded-md bg-background-stronger motion-reduce:animate-none" />
      <div class="h-4 w-1/3 animate-pulse rounded-md bg-background-stronger motion-reduce:animate-none" />
    </div>
  )
}

/**
 * Static, non-interactive status chips mirroring the New-stream dialog's chip
 * row: the Task's state, its dependency count (when it waits on other work), and
 * one chip per completion requirement carrying its evidence status. The
 * requirement description moves to each chip's title so no information is lost.
 */
function TaskChips(props: { item: WorkItemDto; source: WorkGraphWaitingSource }) {
  const [evidence] = createResource(() => props.item.id, (workItemId) => props.source.evidence(workItemId))
  const recorded = createMemo(() => new Set(evidence()?.flatMap((entry) => entry.requirementId ? [entry.requirementId] : []) ?? []))
  const evidenceNeeded = () => ["result_ready", "verification_failed"].includes(props.item.state)
  const requirementStatus = (requirement: WorkItemDto["completionContract"]["requirements"][number]) =>
    recorded().has(requirement.id) ? "evidence recorded" : evidenceNeeded() ? "evidence needed" : "pending"
  // The exact lifecycle stays on the first chip (e.g. "failed", "result ready");
  // the six-label badge in the dialog head carries the owner-facing status.
  return (
    <div class="workgraph-detail-chips" role="group" aria-label="Task status">
      <span class="workgraph-detail-chip">{props.item.state.replaceAll("_", " ")}</span>
      <Show when={props.item.dependencyIds.length}>
        <span class="workgraph-detail-chip">waits for {props.item.dependencyIds.length} task(s)</span>
      </Show>
      <For each={props.item.completionContract.requirements}>
        {(requirement) => (
          <span class="workgraph-detail-chip" title={requirement.description}>
            {requirement.kind.replaceAll("_", " ")}
            <Show when={evidence()}>
              <span classList={{
                "text-icon-success-base": recorded().has(requirement.id),
                "text-icon-critical-base": !recorded().has(requirement.id) && evidenceNeeded(),
                "text-text-base": !recorded().has(requirement.id) && !evidenceNeeded(),
              }}>
                {/* Non-breaking space: ordinary whitespace between flex items is
                    dropped, which glued the kind and status together. */}
                {" · "}{requirementStatus(requirement)}
              </span>
            </Show>
          </span>
        )}
      </For>
      <Show when={evidence.error}>
        <span class="workgraph-detail-chip text-icon-critical-base">Evidence could not be loaded.</span>
      </Show>
    </div>
  )
}

function TaskActivity(props: {
  workItemId: string
  granularity: StreamActivityGranularity
  source: WorkGraphWaitingSource
}) {
  const [entries, setEntries] = createSignal<TaskActivityEntry[]>([])
  const [nextCursor, setNextCursor] = createSignal<TaskActivityPageCursor>()
  const [loading, setLoading] = createSignal(false)
  const [loaded, setLoaded] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const load = async (after?: TaskActivityPageCursor) => {
    if (loading()) return
    setLoading(true)
    setError()
    try {
      const page = await props.source.activity(props.workItemId, { after, granularity: props.granularity, limit: 25 })
      setEntries((current) => {
        const byId = new Map((after ? current : []).map((entry) => [entry.id, entry]))
        page.entries.forEach((entry) => byId.set(entry.id, entry))
        return Array.from(byId.values())
      })
      setNextCursor(page.hasMore ? page.nextCursor : undefined)
      setLoaded(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }
  onMount(() => void load())
  return (
    <DialogSection title="Activity" trailing={<span class="text-[10px] text-text-weaker">{props.granularity}</span>}>
      <Show when={error()}>{(message) => <div class="workgraph-detail-status is-error" role="alert">{message()}</div>}</Show>
      <Show when={loading() && !loaded()}>
        <div class="workgraph-detail-status" role="status">Loading activity…</div>
      </Show>
      <Show when={loaded() && entries().length === 0}>
        <span class="text-[12px] text-text-weaker">No activity yet.</span>
      </Show>
      <ol class="workgraph-activity-list">
        <For each={entries()}>{(entry) => <TaskActivityRow entry={entry} />}</For>
      </ol>
      <Show when={nextCursor()}>
        {(cursor) => (
          <button type="button" class="workgraph-detail-retry" disabled={loading()} onClick={() => void load(cursor())}>
            {loading() ? "Loading…" : "Load earlier activity"}
          </button>
        )}
      </Show>
    </DialogSection>
  )
}

function TaskActivityRow(props: { entry: TaskActivityEntry }) {
  return (
    <li class="workgraph-activity-row">
      <span class="workgraph-activity-icon" data-category={props.entry.category} aria-hidden="true">
        <Icon name={activityIcon(props.entry.category)} size="small" />
      </span>
      <div class="workgraph-activity-copy">
        <span class="text-[12px] leading-5 text-text-base">{props.entry.summary}</span>
        <span class="font-mono text-[10px] text-text-weaker">
          {props.entry.category.replaceAll("_", " ")} · {new Date(props.entry.occurredAt).toLocaleString()}
        </span>
      </div>
      <span class="workgraph-activity-source font-mono text-[10px] text-text-weaker">{props.entry.source.id}</span>
    </li>
  )
}

function activityIcon(category: TaskActivityEntry["category"]): "task" | "terminal" | "check-small" | "help" | "link" | "status" {
  if (category === "run") return "terminal"
  if (category === "checkpoint") return "check-small"
  if (category === "decision") return "help"
  if (category === "evidence") return "link"
  if (category === "external_effect") return "status"
  return "task"
}

function RunContent(props: { runId: string; source: WorkGraphWaitingSource; onOpenSession?: WorkGraphSessionOpener }) {
  const [detail, { refetch }] = createResource(() => props.source.run(props.runId))
  return (
    <DetailState resource={detail} retry={refetch}>
      {(runDetail) => (
        <div class="workgraph-detail">
          <RunDetailView detail={runDetail} onOpenSession={props.onOpenSession} />
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
                  <p class="text-[12px] leading-5 text-text-weak">Open WorkGraph settings to configure the execution defaults this background work needs.</p>
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
