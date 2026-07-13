import type { AttemptDto, CommandResult, OutcomeDto, RecapDto, StreamDto, WorkItemDto } from "@claxedo/workgraph/contracts"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Popover } from "@opencode-ai/ui/popover"
import { createResource, createSignal, For, type JSX, Match, onCleanup, Show, Switch } from "solid-js"
import type { WorkGraphClient } from "./api"

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
}) {
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set(props.streams[0] ? [props.streams[0].id] : []))
  const toggle = (id: string) =>
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <Show when={props.streams.length} fallback={props.empty}>
      <section class="workgraph-tree" aria-label="Streams">
        <For each={props.streams}>
          {(stream) => (
            <StreamTreeItem
              stream={stream}
              outcomes={props.outcomes.filter((outcome) => outcome.streamId === stream.id)}
              items={props.items.filter((item) => item.streamId === stream.id && item.state !== "abandoned")}
              attempts={props.attempts.filter((attempt) => attempt.streamId === stream.id)}
              expanded={expanded().has(stream.id)}
              onToggle={() => toggle(stream.id)}
              relativeTime={props.relativeTime}
              client={props.client}
              mutate={props.mutate}
              onOpenStreamSettings={props.onOpenStreamSettings}
            />
          )}
        </For>
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
}) {
  const liveAttempts = () => props.attempts.filter((attempt) => ["admitted", "placing", "running"].includes(attempt.state))
  const unassigned = () => props.items.filter((item) => !item.outcomeId)
  const completed = () => props.items.filter((item) => item.state === "completed").length
  const needsAttention = () =>
    props.items.some((item) => ["blocked", "failed", "verification_failed", "review_needed", "integration_needed", "attention"].includes(item.state))
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
  const removeStream = async () => {
    if (removing()) return
    setRemoving(true)
    try {
      const reason = "Deleted from overview"
      const removed = await props.mutate(async () => {
        const result = await props.client.deleteStream(props.stream.id, props.stream.version, reason)
        if (!result.ok && result.error.code === "close_required") {
          return props.client.closeStream(props.stream.id, props.stream.version, reason)
        }
        return result
      })
      if (removed) setConfirming(false)
    } finally {
      setRemoving(false)
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
        <Show when={streamTone()}>{(tone) => <span class="workgraph-status-dot" data-tone={tone()} aria-hidden="true" />}</Show>
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
            <div class="workgraph-recap-pop" role="group" aria-label="Latest recap" onMouseEnter={openRecap} onMouseLeave={scheduleRecapClose}>
              <Switch>
                <Match when={recap.loading && !recap()}>
                  <div class="workgraph-detail-status" role="status" aria-live="polite">
                    Loading recap…
                  </div>
                </Match>
                <Match when={recap.error}>
                  <div class="workgraph-detail-status is-error" role="alert">
                    {String((recap.error as { message?: string })?.message ?? "Recap could not be loaded.")}
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
                        {loaded().actionableReferences.length} actionable ref{loaded().actionableReferences.length === 1 ? "" : "s"}
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
          <span>{Object.keys(props.stream.executionDefaults).length ? `${Object.keys(props.stream.executionDefaults).length} Stream overrides` : "inherits WorkGraph defaults"}</span>
          <Show when={liveAttempts().length}>
            <span aria-hidden="true">·</span>
            <span class="workgraph-running">{liveAttempts().length} running</span>
          </Show>
        </span>
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
        <span class="workgraph-stream-time text-text-weaker">{props.relativeTime(props.stream.activity.lastActivityAt)}</span>
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
            "aria-label": `Delete stream ${props.stream.title}`,
            onClick: (event: MouseEvent) => event.stopPropagation(),
          }}
        >
          <div class="workgraph-confirm">
            <p class="workgraph-confirm-text">
              Delete <b>{props.stream.title}</b>? Its planned work is discarded. If the stream has durable effects it's closed instead — the record is kept.
            </p>
            <div class="workgraph-confirm-actions">
              <Button size="small" variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button size="small" variant="primary" disabled={removing()} onClick={() => void removeStream()}>
                {removing() ? "Deleting…" : "Delete stream"}
              </Button>
            </div>
          </div>
        </Popover>
      </div>
      <Show when={props.expanded}>
        <div class="workgraph-stream-children">
          <For each={props.outcomes}>
            {(outcome) => (
              <OutcomeGroup
                outcome={outcome}
                items={props.items.filter((item) => item.outcomeId === outcome.id)}
                attempts={props.attempts}
                streamId={props.stream.id}
                client={props.client}
                mutate={props.mutate}
              />
            )}
          </For>
          <Show when={props.outcomes.length > 0 && unassigned().length}>
            <OutcomeGroup items={unassigned()} attempts={props.attempts} streamId={props.stream.id} client={props.client} mutate={props.mutate} />
          </Show>
          <Show when={props.outcomes.length === 0}>
            <div class="workgraph-leaves workgraph-stream-leaves">
              <For each={unassigned()}>
                {(item) => <WorkItemLeaf item={item} attempts={props.attempts} client={props.client} mutate={props.mutate} />}
              </For>
            </div>
          </Show>
          <div class="workgraph-stream-add">
            <InlineAddTask streamId={props.stream.id} scopeLabel={props.stream.title} client={props.client} mutate={props.mutate} />
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
}) {
  const shipped = () => props.outcome?.state === "completed"
  return (
    <div class="workgraph-outcome">
      <div class="workgraph-outcome-head">
        <Show
          when={shipped()}
          fallback={<span class="workgraph-outcome-marker" classList={{ "is-orphan": !props.outcome }} aria-hidden="true" />}
        >
          <Icon name="circle-check" size="small" class="workgraph-outcome-check" />
        </Show>
        <span class="workgraph-outcome-title text-text-base" classList={{ "is-shipped": shipped() }}>
          {props.outcome?.title ?? "Unassigned tasks"}
        </span>
        <Show when={props.outcome}>
          <span class="workgraph-outcome-crit text-text-weaker">
            {props.outcome!.successCriteria.length} {props.outcome!.successCriteria.length === 1 ? "criterion" : "criteria"}
          </span>
        </Show>
        <Show when={shipped()}>
          <span class="workgraph-chip is-success">Shipped</span>
        </Show>
      </div>
      <div class="workgraph-leaves">
        <For each={props.items}>
          {(item) => <WorkItemLeaf item={item} attempts={props.attempts} client={props.client} mutate={props.mutate} />}
        </For>
        <Show when={props.outcome}>
          <InlineAddTask streamId={props.streamId} outcomeId={props.outcome!.id} scopeLabel={props.outcome!.title} client={props.client} mutate={props.mutate} />
        </Show>
      </div>
    </div>
  )
}

function WorkItemLeaf(props: { item: WorkItemDto; attempts: AttemptDto[]; client: WorkGraphClient; mutate: Mutate }) {
  const waits = () => props.item.dependencyIds.length
  const hasLiveAttempt = () =>
    props.attempts.some(
      (attempt) => attempt.workItemId === props.item.id && ["admitted", "placing", "running"].includes(attempt.state),
    )
  const [busy, setBusy] = createSignal(false)
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
  const showState = () => props.item.state !== "pending"

  return (
    <div class="workgraph-leaf">
      <span class="workgraph-status-dot" data-tone={statusTone(props.item.state)} aria-hidden="true" />
      <span class="workgraph-leaf-title text-text-base">{props.item.title}</span>
      <Show when={waits()}>
        <span class="workgraph-leaf-waits text-text-weaker">waits for {waits()}</span>
      </Show>
      <span class="workgraph-leaf-gap" aria-hidden="true" />
      <Show when={showState()}>
        <span class="workgraph-leaf-state text-text-weaker">{props.item.state.replaceAll("_", " ")}</span>
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

function InlineAddTask(props: { streamId: string; outcomeId?: string; scopeLabel: string; client: WorkGraphClient; mutate: Mutate }) {
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
          autofocus
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

function statusTone(state: string): "critical" | "active" | "info" {
  if (["blocked", "failed", "attention", "verification_failed"].includes(state)) return "critical"
  if (["running", "active", "ready", "completed"].includes(state)) return "active"
  return "info"
}

function recapGeneratedLabel(recap: RecapDto, relativeTime: (timestamp: number) => string) {
  const generation = recap.generation
  if (generation.state === "succeeded") return relativeTime(generation.generatedAt)
  if (generation.state === "failed") return generation.failedAt ? `failed · ${relativeTime(generation.failedAt)}` : "failed"
  return "invalidated"
}
