import type {
  AttemptDto,
  CommandResult,
  ExecutionMode,
  OutcomeDto,
  RecapDto,
  StreamDto,
  WorkItemDto,
} from "@claxedo/workgraph/contracts"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Popover } from "@opencode-ai/ui/popover"
import { createResource, createSignal, For, type Accessor, type JSX, Match, onCleanup, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { Persist, persisted } from "@/platform/persistence/persist"
import type { WorkGraphClient, WorkGraphSessionOpener } from "./api"

type Mutate = (action: () => Promise<CommandResult>) => Promise<boolean>

export function WorkGraphStreamTree(props: {
  streams: StreamDto[]
  outcomes: OutcomeDto[]
  items: WorkItemDto[]
  attempts: AttemptDto[]
  empty: JSX.Element
  relativeTime: (timestamp: number) => string
  client: WorkGraphClient
  mutate: Mutate
  onOpenStreamSettings: (stream: StreamDto) => void
  onOpenTask: (item: WorkItemDto, invoker: HTMLElement) => void
  onOpenSession?: WorkGraphSessionOpener
}) {
  // Expanded Streams are route-restorable: WorkGraph is a single global surface,
  // so the set persists under a global key and survives a /workgraph reload. The
  // persisted map holds only explicit user choices; a Stream with no entry falls
  // back to the approved default (the lead Stream expanded, the rest collapsed).
  // Because the default is derived rather than written, a first-ever visit needs
  // no seeding and a deliberately-collapsed lead persists its `false`. Expansion
  // is only ever read against the live Streams, so a stale id for a Stream that no
  // longer exists is inert and never renders a phantom row.
  const [expandedState, setExpandedState] = persisted(
    Persist.global("workgraph.expanded-streams.v1"),
    createStore<{ ids: Record<string, boolean> }>({ ids: {} }),
  )
  const isExpanded = (id: string) => expandedState.ids[id] ?? id === props.streams[0]?.id
  const toggle = (id: string) => setExpandedState("ids", id, !isExpanded(id))

  return (
    <Show when={props.streams.length} fallback={props.empty}>
      <section class="workgraph-tree" aria-label="Streams">
        <KeyedById records={props.streams}>
          {(stream) => (
            <StreamTreeItem
              stream={stream()}
              outcomes={props.outcomes.filter((outcome) => outcome.streamId === stream().id)}
              items={props.items.filter((item) => item.streamId === stream().id && item.state !== "abandoned")}
              attempts={props.attempts.filter((attempt) => attempt.streamId === stream().id)}
              expanded={isExpanded(stream().id)}
              onToggle={() => toggle(stream().id)}
              relativeTime={props.relativeTime}
              client={props.client}
              mutate={props.mutate}
              onOpenStreamSettings={props.onOpenStreamSettings}
              onOpenTask={props.onOpenTask}
              onOpenSession={props.onOpenSession}
            />
          )}
        </KeyedById>
      </section>
    </Show>
  )
}

function StreamTreeItem(props: {
  stream: StreamDto
  outcomes: OutcomeDto[]
  items: WorkItemDto[]
  attempts: AttemptDto[]
  expanded: boolean
  onToggle: () => void
  relativeTime: (timestamp: number) => string
  client: WorkGraphClient
  mutate: Mutate
  onOpenStreamSettings: (stream: StreamDto) => void
  onOpenTask: (item: WorkItemDto, invoker: HTMLElement) => void
  onOpenSession?: WorkGraphSessionOpener
}) {
  const liveAttempts = () =>
    props.attempts.filter((attempt) => ["admitted", "placing", "running"].includes(attempt.state))
  const unassigned = () => props.items.filter((item) => !item.outcomeId)
  const completed = () => props.items.filter((item) => item.state === "completed").length
  const executionTarget = () => {
    const environment = props.stream.executionDefaults.environment
    const revision = props.stream.executionDefaults.repository?.baseRevision
    if (!environment || !revision) return "Execution target required"
    if (environment.kind === "local_worktree" && !environment.directory) return "Execution target required"
    if (environment.kind === "hosted_workspace" && !environment.repositoryUrl) return "Execution target required"
    return `${environment.kind === "local_worktree" ? "Local worktree" : "Cloud workspace"} · ${revision}`
  }
  const needsAttention = () =>
    props.items.some((item) =>
      ["blocked", "failed", "verification_failed", "review_needed", "integration_needed", "attention"].includes(
        item.state,
      ),
    )
  const streamTone = (): "critical" | "active" | "info" | undefined =>
    props.stream.lifecycleState === "paused" || props.stream.lifecycleState === "closed"
      ? "info"
      : needsAttention()
        ? "critical"
        : liveAttempts().length
          ? "active"
          : undefined
  const [confirming, setConfirming] = createSignal(false)
  const [removing, setRemoving] = createSignal(false)
  // Recap is Stream-owned: the icon shows only when the stream has a latest recap,
  // and the preview is fetched lazily (armed on first hover/focus) from the real
  // recap detail — never fabricated. Hover and keyboard focus both open it.
  const [recapOpen, setRecapOpen] = createSignal(false)
  const [recapArmed, setRecapArmed] = createSignal(false)
  const [recap] = createResource(
    () => (recapArmed() ? props.stream.activity.lastRecapId : undefined),
    (recapId) => props.client.recap(recapId),
  )
  let recapCloseTimer: ReturnType<typeof setTimeout> | undefined
  const openRecap = () => {
    clearTimeout(recapCloseTimer)
    setRecapArmed(true)
    setRecapOpen(true)
  }
  const scheduleRecapClose = () => {
    clearTimeout(recapCloseTimer)
    recapCloseTimer = setTimeout(() => setRecapOpen(false), 90)
  }
  onCleanup(() => clearTimeout(recapCloseTimer))
  // A Stream's durableEffectCount drives one explicit lifecycle action — never a
  // fallback. Zero durable effects means the Stream is disposable, so Delete
  // destroys its planned work and environment. Any durable effect means Close,
  // which preserves the durable history and abandons unfinished work. If a race
  // makes the backend reject the chosen command, mutate surfaces the typed error
  // and the refreshed snapshot re-renders the now-correct single action for the
  // user to invoke again; we never auto-issue the other command.
  const hasDurableEffects = () => props.stream.durableEffectCount > 0
  const removeStream = async () => {
    if (removing()) return
    setRemoving(true)
    try {
      const removed = await props.mutate(() =>
        hasDurableEffects()
          ? props.client.closeStream(props.stream.id, props.stream.version, "Closed from overview")
          : props.client.deleteStream(props.stream.id, props.stream.version, "Deleted from overview"),
      )
      if (removed) setConfirming(false)
    } finally {
      setRemoving(false)
    }
  }
  // Execution is offered only when the current, client-observable Stream/task
  // state matches what the backend's execute_stream would accept: the Stream is
  // neither paused nor closed, and at least one Work Item is a ready batch
  // member — pending with every dependency already completed. Decisions and
  // leases are backend-only refinements we never fabricate; if a race makes the
  // ready batch unadmittable, the server's typed rejection surfaces via mutate.
  const executable = () => {
    if (props.stream.lifecycleState === "paused" || props.stream.lifecycleState === "closed") return false
    const completedIds = new Set(props.items.filter((item) => item.state === "completed").map((item) => item.id))
    return props.items.some(
      (item) => item.state === "pending" && item.dependencyIds.every((dependencyId) => completedIds.has(dependencyId)),
    )
  }
  const [executeOpen, setExecuteOpen] = createSignal(false)
  const [executing, setExecuting] = createSignal(false)
  const [retrying, setRetrying] = createSignal(false)
  const retryableItems = () =>
    props.stream.lifecycleState === "active"
      ? props.items.filter((item) => isRetryable(item, props.attempts))
      : []
  // The mode is always explicit — the popover never defaults; the user picks
  // supervised (one ready batch, then stop) or autonomous (keep launching newly
  // ready tasks until blocked/attention/complete), and we call that exact mode.
  const runExecution = async (executionMode: ExecutionMode) => {
    if (executing()) return
    setExecuting(true)
    try {
      const launched = await props.mutate(() => props.client.executeStream(props.stream.id, executionMode))
      if (launched) setExecuteOpen(false)
    } finally {
      setExecuting(false)
    }
  }
  const retryStream = async (event: MouseEvent) => {
    event.stopPropagation()
    if (retrying()) return
    setRetrying(true)
    try {
      for (const item of retryableItems()) {
        const retried = await props.mutate(() => props.client.retryWorkItem(item.id, item.version))
        if (!retried) return
      }
    } finally {
      setRetrying(false)
    }
  }

  return (
    <div class="workgraph-stream" classList={{ "is-open": props.expanded }}>
      <div class="workgraph-stream-row" onClick={() => props.onToggle()}>
        <button
          type="button"
          class="workgraph-disclosure"
          aria-label={props.expanded ? `Collapse ${props.stream.title}` : `Expand ${props.stream.title}`}
          aria-expanded={props.expanded}
          onClick={(event) => {
            event.stopPropagation()
            props.onToggle()
          }}
        >
          <Icon name="chevron-right" size="small" />
        </button>
        <Show when={streamTone()}>
          {(tone) => <span class="workgraph-status-dot" data-tone={tone()} aria-hidden="true" />}
        </Show>
        <span class="workgraph-stream-title">{props.stream.title}</span>
        <Show when={props.stream.activity.lastRecapId}>
          <Popover
            placement="bottom-start"
            portal
            style={{ "z-index": "400" }}
            open={recapOpen()}
            onOpenChange={setRecapOpen}
            trigger={<Icon name="bullet-list" size="small" />}
            triggerAs="button"
            triggerProps={{
              type: "button",
              class: "workgraph-recap-chip",
              "aria-label": `Latest recap for ${props.stream.title}`,
              onClick: (event: MouseEvent) => event.stopPropagation(),
              onMouseEnter: openRecap,
              onMouseLeave: scheduleRecapClose,
              onFocus: openRecap,
              onBlur: scheduleRecapClose,
            }}
          >
            <div
              class="workgraph-recap-pop"
              role="group"
              aria-label="Latest recap"
              onMouseEnter={openRecap}
              onMouseLeave={scheduleRecapClose}
            >
              <Switch>
                <Match when={recap.loading && !recap()}>
                  <div class="workgraph-detail-status" role="status" aria-live="polite">
                    Loading recap…
                  </div>
                </Match>
                <Match when={recap.error}>
                  <div class="workgraph-detail-status is-error" role="alert">
                    {recap.error instanceof Error ? recap.error.message : String(recap.error)}
                  </div>
                </Match>
                <Match when={recap()}>
                  {(loaded) => (
                    <>
                      <div class="workgraph-recap-pop-head text-text-weaker">
                        <span>Latest recap</span>
                        <span>{recapGeneratedLabel(loaded(), props.relativeTime)}</span>
                      </div>
                      <p class="workgraph-recap-pop-summary text-text-base">{loaded().summary}</p>
                      <div class="workgraph-recap-pop-meta text-text-weaker">
                        {loaded().actionableReferences.length} actionable ref
                        {loaded().actionableReferences.length === 1 ? "" : "s"}
                      </div>
                    </>
                  )}
                </Match>
              </Switch>
            </div>
          </Popover>
        </Show>
        <span class="workgraph-stream-meta text-text-weaker">
          <span>
            {props.outcomes.length} {props.outcomes.length === 1 ? "outcome" : "outcomes"}
          </span>
          <span aria-hidden="true">·</span>
          <span>
            {props.items.length} {props.items.length === 1 ? "task" : "tasks"}
            {completed() ? ` · ${completed()} done` : ""}
          </span>
          <span aria-hidden="true">·</span>
          <span>{executionTarget()}</span>
          <Show when={liveAttempts().length}>
            <span aria-hidden="true">·</span>
            <span class="workgraph-running">{liveAttempts().length} running</span>
          </Show>
        </span>
        <Show when={executable()}>
          <Popover
            placement="bottom-end"
            portal
            style={{ "z-index": "400" }}
            open={executeOpen()}
            onOpenChange={setExecuteOpen}
            trigger={<Icon name="console" size="small" />}
            triggerAs="button"
            triggerProps={{
              type: "button",
              class: "workgraph-row-settings",
              "aria-label": `Execute stream ${props.stream.title}`,
              onClick: (event: MouseEvent) => event.stopPropagation(),
            }}
          >
            <div class="workgraph-confirm" role="menu" aria-label={`Execute stream ${props.stream.title}`}>
              <p class="workgraph-confirm-text">
                <b>Supervised</b> runs the currently ready batch once and stops. <b>Autonomous</b> keeps launching newly
                ready tasks until the Stream is blocked, needs attention, or is complete.
              </p>
              <div class="workgraph-confirm-actions">
                <Button
                  size="small"
                  variant="secondary"
                  role="menuitem"
                  disabled={executing()}
                  onClick={() => void runExecution("supervised")}
                >
                  Supervised
                </Button>
                <Button
                  size="small"
                  variant="primary"
                  role="menuitem"
                  disabled={executing()}
                  onClick={() => void runExecution("autonomous")}
                >
                  Autonomous
                </Button>
              </div>
            </div>
          </Popover>
        </Show>
        <Show when={retryableItems().length}>
          <button
            type="button"
            class="workgraph-row-settings"
            aria-label={`Retry stream ${props.stream.title}`}
            disabled={retrying()}
            onClick={(event) => void retryStream(event)}
          >
            <Icon name="reset" size="small" />
          </button>
        </Show>
        <button
          type="button"
          class="workgraph-row-settings"
          aria-label={`Stream settings for ${props.stream.title}`}
          onClick={(event) => {
            event.stopPropagation()
            props.onOpenStreamSettings(props.stream)
          }}
        >
          <Icon name="sliders" size="small" />
        </button>
        <span class="workgraph-stream-time text-text-weaker">
          {props.relativeTime(props.stream.activity.lastActivityAt)}
        </span>
        <Popover
          placement="bottom-end"
          portal
          style={{ "z-index": "400" }}
          open={confirming()}
          onOpenChange={setConfirming}
          trigger={<Icon name="trash" size="small" />}
          triggerAs="button"
          triggerProps={{
            type: "button",
            class: "workgraph-row-delete",
            "aria-label": `${hasDurableEffects() ? "Close" : "Delete"} stream ${props.stream.title}`,
            onClick: (event: MouseEvent) => event.stopPropagation(),
          }}
        >
          <div class="workgraph-confirm">
            <p class="workgraph-confirm-text">
              <Show
                when={hasDurableEffects()}
                fallback={
                  <>
                    Delete <b>{props.stream.title}</b>? Its disposable planned work and environment are destroyed. It
                    has no durable history to keep.
                  </>
                }
              >
                Close <b>{props.stream.title}</b>? Its durable history is preserved and any unfinished work is
                abandoned.
              </Show>
            </p>
            <div class="workgraph-confirm-actions">
              <Button size="small" variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button size="small" variant="primary" disabled={removing()} onClick={() => void removeStream()}>
                {removing()
                  ? hasDurableEffects()
                    ? "Closing…"
                    : "Deleting…"
                  : hasDurableEffects()
                    ? "Close stream"
                    : "Delete stream"}
              </Button>
            </div>
          </div>
        </Popover>
      </div>
      <Show when={props.expanded}>
        <div class="workgraph-stream-children">
          <KeyedById records={props.outcomes}>
            {(outcome) => (
              <OutcomeGroup
                outcome={outcome()}
                items={props.items.filter((item) => item.outcomeId === outcome().id)}
                attempts={props.attempts}
                streamId={props.stream.id}
                client={props.client}
                mutate={props.mutate}
                onOpenSession={props.onOpenSession}
                onOpenTask={props.onOpenTask}
              />
            )}
          </KeyedById>
          <Show when={props.outcomes.length > 0 && unassigned().length}>
            <OutcomeGroup
              items={unassigned()}
              attempts={props.attempts}
              streamId={props.stream.id}
              client={props.client}
              mutate={props.mutate}
              onOpenSession={props.onOpenSession}
              onOpenTask={props.onOpenTask}
            />
          </Show>
          <Show when={props.outcomes.length === 0}>
            <div class="workgraph-leaves workgraph-stream-leaves">
              <KeyedById records={unassigned()}>
                {(item) => (
                  <WorkItemLeaf item={item()} attempts={props.attempts} client={props.client} mutate={props.mutate} onOpenTask={props.onOpenTask} onOpenSession={props.onOpenSession} />
                )}
              </KeyedById>
            </div>
          </Show>
          <div class="workgraph-stream-add">
            <InlineAddTask
              streamId={props.stream.id}
              scopeLabel={props.stream.title}
              client={props.client}
              mutate={props.mutate}
            />
          </div>
        </div>
      </Show>
    </div>
  )
}

function OutcomeGroup(props: {
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

function WorkItemLeaf(props: {
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
      <span class="workgraph-status-dot" data-tone={statusTone(props.item.state)} aria-hidden="true" />
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

function isRetryable(item: WorkItemDto, attempts: AttemptDto[]) {
  if (["completed", "abandoned"].includes(item.state)) return false
  if (["failed", "verification_failed"].includes(item.state)) return true
  return ["attention", "failed", "cancelled"].includes(
    attempts
      .filter((attempt) => attempt.workItemId === item.id)
      .toSorted((left, right) => left.attemptNumber - right.attemptNumber)
      .at(-1)?.state ?? "",
  )
}

function InlineAddTask(props: {
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

function KeyedById<T extends { id: string }>(props: {
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

function statusTone(state: string): "critical" | "active" | "info" {
  if (["blocked", "failed", "attention", "verification_failed"].includes(state)) return "critical"
  if (["running", "active", "ready", "completed"].includes(state)) return "active"
  return "info"
}

function recapGeneratedLabel(recap: RecapDto, relativeTime: (timestamp: number) => string) {
  const generation = recap.generation
  if (generation.state === "succeeded") return relativeTime(generation.generatedAt)
  if (generation.state === "failed")
    return generation.failedAt ? `failed · ${relativeTime(generation.failedAt)}` : "failed"
  return "invalidated"
}
