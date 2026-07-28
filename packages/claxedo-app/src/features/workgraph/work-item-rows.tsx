import type { AttemptDto, CommandResult, OutcomeDto, WorkItemDto } from "@claxedo/workgraph/contracts"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { createSignal, For, Match, Switch, type Accessor, type JSX, Show } from "solid-js"
import type { WorkGraphClient, WorkGraphSessionOpener } from "./api"
import { capture as phCapture, identityProps } from "@/platform/telemetry/analytics"

/**
 * Best-effort extraction of `create_work_item`'s command-result id. The client's
 * `Mutate` wrapper (see below) only ever returns a boolean — this reads the id
 * out of the raw `CommandResult` before it is discarded, for `workgraph_task_created`
 * telemetry only. Returns undefined on any unexpected shape rather than guessing.
 */
function createdWorkItemId(result: CommandResult): string | undefined {
  if (!result.ok) return undefined
  const value = result.value
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const id = (value as Record<string, unknown>).workItemId
  return typeof id === "string" ? id : undefined
}

export type Mutate = (action: () => Promise<CommandResult>) => Promise<boolean>

/** The owner-facing lifecycle labels. Staged tasks await the owner's approval;
 *  Waiting/Ready are the two derived halves of an approved `pending` item split
 *  on whether its blockers are settled; Running is executing; Needs-you is any
 *  attention state; Done shipped. Abandoned never renders. Waiting vs Ready is
 *  derived per render, never stored. */
export type TaskStatusLabel = "staged" | "waiting" | "ready" | "running" | "needs-you" | "done"

/** The owner-facing label for a work item. `depsComplete` is whether every
 *  blocker is settled (completed/abandoned) — the only input that splits an
 *  approved `pending` item into Waiting vs Ready. */
export function taskStatusLabel(state: WorkItemDto["state"], depsComplete: boolean): TaskStatusLabel {
  if (state === "pending_approval") return "staged"
  if (state === "active") return "running"
  if (state === "completed") return "done"
  if (["result_ready", "review_needed", "integration_needed", "blocked", "verification_failed", "failed"].includes(state)) {
    return "needs-you"
  }
  // pending (approved): Ready when launchable now, else Waiting on a blocker.
  return depsComplete ? "ready" : "waiting"
}

/** Blockers are satisfied when every dependency is completed or abandoned (an
 *  abandoned blocker unblocks its dependents). A dependency absent from the
 *  provided set — the abandoned rows the overview filters out before rendering —
 *  reads as satisfied for the same reason. */
export function createDependencyResolver(items: WorkItemDto[]): (item: WorkItemDto) => boolean {
  const stateById = new Map(items.map((item) => [item.id, item.state] as const))
  return (item) =>
    item.dependencyIds.every((id) => {
      const state = stateById.get(id)
      return state === undefined || state === "completed" || state === "abandoned"
    })
}

/** Human label for the six-label status, shared by rows and the inspector. */
export const STATUS_DISPLAY: Record<TaskStatusLabel, string> = {
  staged: "Staged",
  waiting: "Waiting",
  ready: "Ready",
  running: "Running",
  "needs-you": "Needs you",
  done: "Done",
}

const STATUS_ORDER: Record<TaskStatusLabel, number> = {
  "needs-you": 0,
  running: 1,
  staged: 2,
  ready: 3,
  waiting: 4,
  done: 5,
}

/** Stable status ordering: what needs you first, then running, then staged
 *  (awaiting approval), then the ready/waiting queue, with shipped work last.
 *  Ties keep the snapshot's order. */
export function sortByStatusLabel(items: WorkItemDto[], depsComplete: (item: WorkItemDto) => boolean): WorkItemDto[] {
  return [...items].sort(
    (a, b) => STATUS_ORDER[taskStatusLabel(a.state, depsComplete(a))] - STATUS_ORDER[taskStatusLabel(b.state, depsComplete(b))],
  )
}

/** One glyph per label, readable without color: dashed = staged, dotted =
 *  waiting, ring = ready, spinning arc = running, alert = needs you, check =
 *  done. Ready/Waiting/Running have no shared icon in the sprite, so they
 *  render as inline rings at the same 16px box; the running arc spins so live
 *  execution is unmistakable at a glance (static under reduced motion). */
function TaskStatusGlyph(props: { label: TaskStatusLabel }) {
  return (
    <span class="workgraph-leaf-status" data-status={props.label} aria-hidden="true">
      <Switch>
        <Match when={props.label === "staged"}>
          <Icon name="circle-dashed" size="small" />
        </Match>
        <Match when={props.label === "running"}>
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" class="workgraph-leaf-spin">
            <circle cx="10" cy="10" r="7.91667" stroke="currentColor" opacity="0.25" />
            <circle cx="10" cy="10" r="7.91667" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-dasharray="13 36.75" />
          </svg>
        </Match>
        <Match when={props.label === "needs-you"}>
          <Icon name="circle-alert" size="small" />
        </Match>
        <Match when={props.label === "done"}>
          <Icon name="circle-check" size="small" />
        </Match>
        <Match when={props.label === "ready"}>
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
            <circle cx="10" cy="10" r="7.91667" stroke="currentColor" />
          </svg>
        </Match>
        <Match when={props.label === "waiting"}>
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
            <circle cx="10" cy="10" r="7.91667" stroke="currentColor" stroke-dasharray="0.5 2.5" stroke-linecap="round" />
          </svg>
        </Match>
      </Switch>
    </span>
  )
}
export function OutcomeGroup(props: {
  outcome?: OutcomeDto
  items: WorkItemDto[]
  attempts: AttemptDto[]
  streamId: string
  client: WorkGraphClient
  mutate: Mutate
  /** Whether a given item's blockers are all settled (splits Waiting vs Ready). */
  depsComplete: (item: WorkItemDto) => boolean
  /** Whether the owning stream is paused (Ready rows show "Ready · paused"). */
  streamPaused: boolean
  onOpenTask: (item: WorkItemDto, invoker: HTMLElement) => void
  onOpenSession?: WorkGraphSessionOpener
}) {
  const shipped = () => props.outcome?.state === "completed"
  return (
    <div class="workgraph-outcome">
      <div class="workgraph-outcome-head">
        <Show
          when={shipped()}
          fallback={
            <span class="workgraph-outcome-marker" classList={{ "is-orphan": !props.outcome }} aria-hidden="true" />
          }
        >
          <Icon name="circle-check" size="small" class="workgraph-outcome-check" />
        </Show>
        <span class="workgraph-outcome-title text-text-base" classList={{ "is-shipped": shipped() }}>
          {props.outcome?.title ?? "Unassigned tasks"}
        </span>
        <Show when={props.outcome}>
          <span class="workgraph-outcome-crit text-text-weaker">
            {props.outcome!.successCriteria.length}{" "}
            {props.outcome!.successCriteria.length === 1 ? "criterion" : "criteria"}
          </span>
        </Show>
        <Show when={shipped()}>
          <span class="workgraph-chip is-success">Shipped</span>
        </Show>
      </div>
      <div class="workgraph-leaves">
        <KeyedById records={props.items}>
          {(item) => <WorkItemLeaf item={item()} attempts={props.attempts} client={props.client} mutate={props.mutate} depsComplete={props.depsComplete(item())} streamPaused={props.streamPaused} onOpenTask={props.onOpenTask} onOpenSession={props.onOpenSession} />}
        </KeyedById>
        <Show when={props.outcome}>
          <InlineAddTask
            streamId={props.streamId}
            outcomeId={props.outcome!.id}
            scopeLabel={props.outcome!.title}
            client={props.client}
            mutate={props.mutate}
          />
        </Show>
      </div>
    </div>
  )
}

export function WorkItemLeaf(props: {
  item: WorkItemDto
  attempts: AttemptDto[]
  client: WorkGraphClient
  mutate: Mutate
  /** Whether the item's blockers are all settled — splits Waiting vs Ready. */
  depsComplete?: boolean
  /** Whether the owning stream is paused — Ready rows read "Ready · paused". */
  streamPaused?: boolean
  onOpenTask: (item: WorkItemDto, invoker: HTMLElement) => void
  onOpenSession?: WorkGraphSessionOpener
}) {
  const label = () => taskStatusLabel(props.item.state, props.depsComplete ?? props.item.dependencyIds.length === 0)
  const waits = () => props.item.dependencyIds.length
  const latestAttempt = () =>
    props.attempts
      .filter((attempt) => attempt.workItemId === props.item.id)
      .toSorted((left, right) => left.attemptNumber - right.attemptNumber)
      .at(-1)
  const hasLiveAttempt = () =>
    props.attempts.some(
      (attempt) => attempt.workItemId === props.item.id && ["admitted", "placing", "running"].includes(attempt.state),
    )
  const [busy, setBusy] = createSignal(false)
  const [sessionError, setSessionError] = createSignal<string>()
  // Reject is a durable abandonment, so it demands a reason before it fires —
  // the row reveals an inline reason field the way the panel does, never a
  // blind one-click destructive action.
  const [rejecting, setRejecting] = createSignal(false)
  const [reason, setReason] = createSignal("")
  const remove = async (event: MouseEvent) => {
    event.stopPropagation()
    if (busy() || hasLiveAttempt()) return
    setBusy(true)
    try {
      await props.mutate(() => props.client.cancelWorkItem(props.item.id, props.item.version, "Deleted from overview"))
    } finally {
      setBusy(false)
    }
  }
  const approve = async (event: MouseEvent) => {
    event.stopPropagation()
    if (busy()) return
    setBusy(true)
    try {
      const ok = await props.mutate(() => props.client.approveWorkItem(props.item.id, props.item.version))
      // `workgraph_task_completed` fires here by design, not on the engine's own
      // `state === "completed"` transition: that transition is entirely
      // server/engine-driven (evidence + integration, no client call), so there is
      // no click handler to bind it to. This is the row's only user-facing
      // "approve" action — it admits a Staged task to run ("Run" / "Approve & run"
      // above), the closest analog the UI has to the task moving forward.
      if (ok) {
        phCapture("workgraph_task_completed", {
          ...identityProps(),
          surface: "workgraph",
          task_id: props.item.id,
          stream_id: props.item.streamId,
          ...(props.item.outcomeId ? { outcome_id: props.item.outcomeId } : {}),
        })
      }
    } finally {
      setBusy(false)
    }
  }
  const confirmReject = async (event?: Event) => {
    event?.stopPropagation()
    const text = reason().trim()
    if (busy() || !text) return
    setBusy(true)
    try {
      const rejected = await props.mutate(() => props.client.rejectWorkItem(props.item.id, props.item.version, text))
      if (rejected) {
        setRejecting(false)
        setReason("")
      }
    } finally {
      setBusy(false)
    }
  }
  const retry = async (event: MouseEvent) => {
    event.stopPropagation()
    if (busy() || !isRetryable(props.item, props.attempts)) return
    setBusy(true)
    setSessionError()
    try {
      await props.mutate(() => props.client.retryWorkItem(props.item.id, props.item.version))
    } finally {
      setBusy(false)
    }
  }
  const stop = async (event: MouseEvent) => {
    event.stopPropagation()
    const attempt = latestAttempt()
    if (busy() || attempt?.state !== "running") return
    setBusy(true)
    try {
      await props.mutate(() => props.client.cancelAttempt(attempt.id, attempt.version, "Stopped from task row"))
    } finally {
      setBusy(false)
    }
  }
  const openSession = async (event: MouseEvent) => {
    event.stopPropagation()
    const attempt = latestAttempt()
    if (!attempt) return
    setSessionError()
    try {
      const references = attempt.executionReferences ?? (await props.client.attempt(attempt.id)).executionReferences
      if (!references?.sessionId) {
        setSessionError("Session unavailable")
        return
      }
      await props.onOpenSession?.({
        sessionId: references.sessionId,
        ...(references.workspaceId ? { workspaceId: references.workspaceId } : {}),
        harness: attempt.resolvedExecution.harness,
        environment: attempt.resolvedExecution.environment,
      })
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : "Session unavailable")
    }
  }
  // A needs-you row still names its exact state ("blocked", "verification
  // failed"); every other label is carried by the glyph and its own affordance.
  const showState = () => label() === "needs-you"
  const sessionAvailable = () => {
    const attempt = latestAttempt()
    return !!props.onOpenSession && !!attempt && !["admitted", "placing"].includes(attempt.state)
  }

  return (
    <div
      class="workgraph-leaf"
      classList={{ "is-done": props.item.state === "completed" }}
      data-status={label()}
      role="button"
      tabIndex={0}
      aria-label={`Open task ${props.item.title}`}
      onClick={(event) => props.onOpenTask(props.item, event.currentTarget)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return
        event.preventDefault()
        props.onOpenTask(props.item, event.currentTarget)
      }}
    >
      <TaskStatusGlyph label={label()} />
      <span class="workgraph-leaf-title text-text-base">{props.item.title}</span>
      <Show when={label() === "waiting"}>
        <span class="workgraph-leaf-waits text-text-weaker">waits for {waits()}</span>
      </Show>
      <span class="workgraph-leaf-gap" aria-hidden="true" />
      <Show when={label() === "ready"}>
        <span
          class="workgraph-leaf-state text-text-weaker"
          classList={{ "workgraph-leaf-paused": props.streamPaused }}
        >
          {props.streamPaused ? "Ready · paused" : "Queued"}
        </span>
      </Show>
      <Show when={showState()}>
        <span class="workgraph-leaf-state text-text-weaker">{props.item.state.replaceAll("_", " ")}</span>
      </Show>
      <Show when={latestAttempt()?.state === "cancelled" && isRetryable(props.item, props.attempts)}>
        <span class="workgraph-leaf-state workgraph-leaf-stopped text-text-weaker">Stopped · Retry</span>
      </Show>
      <Show when={sessionError()}>{(message) => <span class="workgraph-leaf-session-error" role="alert">{message()}</span>}</Show>
      <Show when={label() === "staged"}>
        <Show
          when={rejecting()}
          fallback={
            <>
              <button
                type="button"
                class="workgraph-leaf-session"
                aria-label={`Approve task ${props.item.title}`}
                disabled={busy()}
                onClick={(event) => void approve(event)}
              >
                <span>{busy() ? "Approving…" : props.item.createdByActorType === "user" ? "Run" : "Approve & run"}</span>
                <Icon name="check-small" size="small" />
              </button>
              <button
                type="button"
                class="workgraph-row-delete"
                aria-label={`Reject task ${props.item.title}`}
                disabled={busy()}
                onClick={(event) => {
                  event.stopPropagation()
                  setRejecting(true)
                }}
              >
                <Icon name="close-small" size="small" />
              </button>
            </>
          }
        >
          <input
            ref={(input) => requestAnimationFrame(() => input.isConnected && input.focus())}
            class="workgraph-add-task-input"
            aria-label={`Reject reason for ${props.item.title}`}
            value={reason()}
            disabled={busy()}
            placeholder="Reason to reject, then Enter"
            onClick={(event) => event.stopPropagation()}
            onInput={(event) => setReason(event.currentTarget.value)}
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.key === "Enter") {
                event.preventDefault()
                void confirmReject(event)
              }
              if (event.key === "Escape") {
                setRejecting(false)
                setReason("")
              }
            }}
          />
          <button
            type="button"
            class="workgraph-leaf-session"
            aria-label={`Confirm reject ${props.item.title}`}
            disabled={busy() || !reason().trim()}
            onClick={(event) => void confirmReject(event)}
          >
            <span>{busy() ? "Rejecting…" : "Reject"}</span>
          </button>
        </Show>
      </Show>
      <Show when={isRetryable(props.item, props.attempts)}>
        <button
          type="button"
          class="workgraph-leaf-session workgraph-leaf-retry"
          aria-label={`Retry task ${props.item.title}`}
          disabled={busy()}
          onClick={(event) => void retry(event)}
        >
          <span>{busy() ? "Retrying…" : "Retry"}</span>
          <Icon name="reset" size="small" />
        </button>
      </Show>
      <Show when={latestAttempt()?.state === "running"}>
        <button
          type="button"
          class="workgraph-leaf-session workgraph-leaf-stop"
          aria-label={`Stop task ${props.item.title}`}
          disabled={busy()}
          onClick={(event) => void stop(event)}
        >
          <span>{busy() ? "Stopping…" : "Stop"}</span>
          <Icon name="stop" size="small" />
        </button>
      </Show>
      <Show when={sessionAvailable()}>
        <button
          type="button"
          class="workgraph-leaf-session"
          aria-label={`Open session for ${props.item.title}`}
          onClick={(event) => void openSession(event)}
        >
          <span>Session</span>
          <Icon name="arrow-right" size="small" />
        </button>
      </Show>
      {/* A staged row's Reject is its removal path (abandon with a reason); the
          plain delete only serves the non-staged rows. */}
      <Show when={!hasLiveAttempt() && label() !== "staged"}>
        <button
          type="button"
          class="workgraph-row-delete"
          aria-label={`Delete task ${props.item.title}`}
          disabled={busy()}
          onClick={remove}
        >
          <Icon name="trash" size="small" />
        </button>
      </Show>
    </div>
  )
}

export function isRetryable(item: WorkItemDto, attempts: AttemptDto[]) {
  if (["completed", "abandoned"].includes(item.state)) return false
  if (["failed", "verification_failed"].includes(item.state)) return true
  return ["attention", "failed", "cancelled"].includes(
    attempts
      .filter((attempt) => attempt.workItemId === item.id)
      .toSorted((left, right) => left.attemptNumber - right.attemptNumber)
      .at(-1)?.state ?? "",
  )
}

export function InlineAddTask(props: {
  streamId: string
  outcomeId?: string
  scopeLabel: string
  client: WorkGraphClient
  mutate: Mutate
}) {
  const [open, setOpen] = createSignal(false)
  const [value, setValue] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const submit = async () => {
    const title = value().trim()
    if (!title || busy()) return
    setBusy(true)
    // `props.mutate` only ever resolves to a boolean, so the created id is read
    // out of the raw CommandResult inside this closure — the exact value the
    // real request returns, not a separate re-derivation.
    let taskId: string | undefined
    const created = await props.mutate(async () => {
      const result = await props.client.createWorkItem({
        streamId: props.streamId,
        ...(props.outcomeId ? { outcomeId: props.outcomeId } : {}),
        title,
        completionContract: {
          version: 1,
          mode: "all",
          requirements: [
            {
              id: `requirement-${crypto.randomUUID()}`,
              kind: "owner_confirmation",
              description: `Confirm ${title} is complete`,
            },
          ],
        },
      })
      taskId = createdWorkItemId(result)
      return result
    })
    setBusy(false)
    if (!created) return
    // Ids only — never the title just typed above.
    if (taskId) {
      phCapture("workgraph_task_created", {
        ...identityProps(),
        surface: "workgraph",
        task_id: taskId,
        stream_id: props.streamId,
        ...(props.outcomeId ? { outcome_id: props.outcomeId } : {}),
      })
    }
    setValue("")
    setOpen(false)
  }

  return (
    <Show
      when={open()}
      fallback={
        <button type="button" class="workgraph-add-task" onClick={() => setOpen(true)}>
          <Icon name="plus-small" size="small" />
          Add task
        </button>
      }
    >
      <div class="workgraph-add-task-row">
        <Icon name="plus-small" size="small" class="workgraph-add-task-icon" />
        <input
          ref={(input) => {
            requestAnimationFrame(() => {
              if (input.isConnected) input.focus()
            })
          }}
          class="workgraph-add-task-input"
          aria-label={`Add task to ${props.scopeLabel}`}
          value={value()}
          disabled={busy()}
          placeholder="Task title, then Enter"
          onInput={(event) => setValue(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              void submit()
            }
            if (event.key === "Escape") {
              setValue("")
              setOpen(false)
            }
          }}
          onBlur={() => {
            if (!value().trim()) setOpen(false)
          }}
        />
      </div>
    </Show>
  )
}

export function KeyedById<T extends { id: string }>(props: {
  records: T[]
  children: (record: Accessor<T>) => JSX.Element
}) {
  // Snapshot refreshes replace DTO objects. Reconcile rows by their durable ID so
  // local interaction state (an open editor, typed draft, focus, or popover) is not
  // destroyed merely because an unrelated WorkGraph change arrived.
  return (
    <For each={props.records.map((record) => record.id)}>
      {(id) => props.children(() => props.records.find((record) => record.id === id)!)}
    </For>
  )
}
