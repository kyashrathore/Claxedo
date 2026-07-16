import type { AttemptDto, CommandResult, OutcomeDto, WorkItemDto } from "@claxedo/workgraph/contracts"
import { Icon } from "@opencode-ai/ui/icon"
import { createSignal, For, type Accessor, type JSX, Show } from "solid-js"
import type { WorkGraphClient, WorkGraphSessionOpener } from "./api"

export type Mutate = (action: () => Promise<CommandResult>) => Promise<boolean>

/** The owner-facing lifecycle buckets: staged work waits to be admitted, in
 *  progress work is executing (the attention states are in-progress variants
 *  that need the owner), done work shipped. Abandoned never renders. */
export type TaskStatusBucket = "attention" | "in_progress" | "staged" | "done"

export function taskStatusBucket(state: WorkItemDto["state"]): TaskStatusBucket {
  if (["blocked", "failed", "verification_failed", "review_needed", "integration_needed"].includes(state)) {
    return "attention"
  }
  if (["active", "result_ready"].includes(state)) return "in_progress"
  if (state === "completed") return "done"
  return "staged"
}

const BUCKET_ORDER: Record<TaskStatusBucket, number> = { attention: 0, in_progress: 1, staged: 2, done: 3 }

/** Stable status ordering: what needs you first, then running, then the staged
 *  queue, with shipped work last. Ties keep the snapshot's order. */
export function sortByStatusBucket(items: WorkItemDto[]): WorkItemDto[] {
  return [...items].sort((a, b) => BUCKET_ORDER[taskStatusBucket(a.state)] - BUCKET_ORDER[taskStatusBucket(b.state)])
}

const BUCKET_ICON: Record<TaskStatusBucket, "circle-dashed" | "circle-half" | "circle-check" | "circle-alert"> = {
  staged: "circle-dashed",
  in_progress: "circle-half",
  done: "circle-check",
  attention: "circle-alert",
}

/** One glyph per lifecycle bucket, readable without color: dashed = staged,
 *  half-filled = in progress, check = done, alert = needs you. */
function TaskStatusIcon(props: { state: WorkItemDto["state"] }) {
  const bucket = () => taskStatusBucket(props.state)
  return (
    <span class="workgraph-leaf-status" data-bucket={bucket()} aria-hidden="true">
      <Icon name={BUCKET_ICON[bucket()]} size="small" />
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
          {(item) => <WorkItemLeaf item={item()} attempts={props.attempts} client={props.client} mutate={props.mutate} onOpenTask={props.onOpenTask} onOpenSession={props.onOpenSession} />}
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
  onOpenTask: (item: WorkItemDto, invoker: HTMLElement) => void
  onOpenSession?: WorkGraphSessionOpener
}) {
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
  const showState = () => props.item.state !== "pending"
  const sessionAvailable = () => {
    const attempt = latestAttempt()
    return !!props.onOpenSession && !!attempt && !["admitted", "placing"].includes(attempt.state)
  }

  return (
    <div
      class="workgraph-leaf"
      classList={{ "is-done": props.item.state === "completed" }}
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
      <TaskStatusIcon state={props.item.state} />
      <span class="workgraph-leaf-title text-text-base">{props.item.title}</span>
      <Show when={waits()}>
        <span class="workgraph-leaf-waits text-text-weaker">waits for {waits()}</span>
      </Show>
      <span class="workgraph-leaf-gap" aria-hidden="true" />
      <Show when={showState()}>
        <span class="workgraph-leaf-state text-text-weaker">{props.item.state.replaceAll("_", " ")}</span>
      </Show>
      <Show when={sessionError()}>{(message) => <span class="workgraph-leaf-session-error" role="alert">{message()}</span>}</Show>
      <Show when={isRetryable(props.item, props.attempts)}>
        <button
          type="button"
          class="workgraph-leaf-session"
          aria-label={`Retry task ${props.item.title}`}
          disabled={busy()}
          onClick={(event) => void retry(event)}
        >
          <span>{busy() ? "Retrying…" : "Retry"}</span>
          <Icon name="reset" size="small" />
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
      <Show when={!hasLiveAttempt()}>
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
    const created = await props.mutate(() =>
      props.client.createWorkItem({
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
      }),
    )
    setBusy(false)
    if (!created) return
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
