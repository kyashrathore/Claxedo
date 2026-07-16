import type {
  AttemptDto,
  ExecutionMode,
  OutcomeDto,
  RecapDto,
  StreamDto,
  WorkItemDto,
} from "@claxedo/workgraph/contracts"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Popover } from "@opencode-ai/ui/popover"
import { createResource, createSignal, For, type JSX, Match, onCleanup, Show, Switch } from "solid-js"
import type { WorkGraphClient, WorkGraphSessionOpener } from "./api"
import { InlineAddTask, isRetryable, KeyedById, WorkItemLeaf, type Mutate } from "./work-item-rows"

/** How many tasks a Stream card previews before deferring to the panel's Tasks tab. */
export const STREAM_CARD_TASK_PREVIEW = 4

/** The Project a Stream belongs to, derived from its own execution target —
 *  never fabricated. Streams without a usable target share the "No project"
 *  group rather than inventing one. */
export type WorkGraphProject = { key: string; label: string; detail?: string }

export function streamProject(stream: StreamDto): WorkGraphProject {
  const environment = stream.executionDefaults.environment
  if (environment?.kind === "local_worktree" && environment.directory) {
    const directory = environment.directory
    return { key: `local:${directory}`, label: directory.split("/").filter(Boolean).at(-1) ?? directory, detail: directory }
  }
  if (environment?.kind === "hosted_workspace" && environment.repositoryUrl) {
    const repositoryUrl = environment.repositoryUrl
    const label = repositoryUrl.split("/").filter(Boolean).at(-1)?.replace(/\.git$/, "") ?? repositoryUrl
    return { key: `hosted:${repositoryUrl}`, label, detail: repositoryUrl }
  }
  return { key: "unassigned", label: "No project" }
}

export function WorkGraphProjectGroups(props: {
  streams: StreamDto[]
  outcomes: OutcomeDto[]
  items: WorkItemDto[]
  attempts: AttemptDto[]
  empty: JSX.Element
  relativeTime: (timestamp: number) => string
  client: WorkGraphClient
  mutate: Mutate
  onOpenStreamSettings: (stream: StreamDto) => void
  onOpenStreamTasks: (stream: StreamDto) => void
  onOpenTask: (item: WorkItemDto, invoker: HTMLElement) => void
  onNewStream: (project: WorkGraphProject) => void
  onOpenSession?: WorkGraphSessionOpener
}) {
  // Streams arrive sorted by recency, so first-seen order also ranks Projects by
  // their most recently active Stream.
  const projects = () => {
    const groups = new Map<string, { project: WorkGraphProject; streams: StreamDto[] }>()
    for (const stream of props.streams) {
      const project = streamProject(stream)
      const group = groups.get(project.key) ?? { project, streams: [] }
      group.streams.push(stream)
      groups.set(project.key, group)
    }
    return [...groups.values()]
  }

  return (
    <Show when={props.streams.length} fallback={props.empty}>
      <section class="workgraph-tree" aria-label="Projects">
        <For each={projects().map((group) => group.project.key)}>
          {(key) => {
            const group = () => projects().find((candidate) => candidate.project.key === key)!
            return (
              <ProjectSection
                project={group().project}
                streams={group().streams}
                outcomes={props.outcomes}
                items={props.items}
                attempts={props.attempts}
                relativeTime={props.relativeTime}
                client={props.client}
                mutate={props.mutate}
                onOpenStreamSettings={props.onOpenStreamSettings}
                onOpenStreamTasks={props.onOpenStreamTasks}
                onOpenTask={props.onOpenTask}
                onNewStream={props.onNewStream}
                onOpenSession={props.onOpenSession}
              />
            )
          }}
        </For>
      </section>
    </Show>
  )
}

function ProjectSection(props: {
  project: WorkGraphProject
  streams: StreamDto[]
  outcomes: OutcomeDto[]
  items: WorkItemDto[]
  attempts: AttemptDto[]
  relativeTime: (timestamp: number) => string
  client: WorkGraphClient
  mutate: Mutate
  onOpenStreamSettings: (stream: StreamDto) => void
  onOpenStreamTasks: (stream: StreamDto) => void
  onOpenTask: (item: WorkItemDto, invoker: HTMLElement) => void
  onNewStream: (project: WorkGraphProject) => void
  onOpenSession?: WorkGraphSessionOpener
}) {
  const streamIds = () => new Set(props.streams.map((stream) => stream.id))
  const items = () => props.items.filter((item) => streamIds().has(item.streamId) && item.state !== "abandoned")
  const needsAttention = () =>
    items().some((item) =>
      ["blocked", "failed", "verification_failed", "review_needed", "integration_needed", "attention"].includes(
        item.state,
      ),
    )
  return (
    <section class="workgraph-project" aria-label={`Project ${props.project.label}`}>
      <div class="workgraph-project-row">
        <Icon name="folder" size="small" class="workgraph-project-icon" />
        <span class="workgraph-project-name text-text-strong">{props.project.label}</span>
        <Show when={needsAttention()}>
          <span class="workgraph-status-dot" data-tone="critical" aria-hidden="true" />
        </Show>
        <Show when={props.project.detail}>
          <span class="workgraph-project-path text-text-weaker">{props.project.detail}</span>
        </Show>
      </div>
      <div class="workgraph-project-cards">
        <KeyedById records={props.streams}>
          {(stream) => (
            <StreamCard
              stream={stream()}
              outcomes={props.outcomes.filter((outcome) => outcome.streamId === stream().id)}
              items={props.items.filter((item) => item.streamId === stream().id && item.state !== "abandoned")}
              attempts={props.attempts.filter((attempt) => attempt.streamId === stream().id)}
              relativeTime={props.relativeTime}
              client={props.client}
              mutate={props.mutate}
              onOpenStreamSettings={props.onOpenStreamSettings}
              onOpenStreamTasks={props.onOpenStreamTasks}
              onOpenTask={props.onOpenTask}
              onOpenSession={props.onOpenSession}
            />
          )}
        </KeyedById>
        <button
          type="button"
          class="workgraph-streamcard-new"
          aria-label={`New stream in ${props.project.label}`}
          onClick={() => props.onNewStream(props.project)}
        >
          <Icon name="plus-small" size="small" />
          New stream
        </button>
      </div>
    </section>
  )
}

function StreamCard(props: {
  stream: StreamDto
  outcomes: OutcomeDto[]
  items: WorkItemDto[]
  attempts: AttemptDto[]
  relativeTime: (timestamp: number) => string
  client: WorkGraphClient
  mutate: Mutate
  onOpenStreamSettings: (stream: StreamDto) => void
  onOpenStreamTasks: (stream: StreamDto) => void
  onOpenTask: (item: WorkItemDto, invoker: HTMLElement) => void
  onOpenSession?: WorkGraphSessionOpener
}) {
  const liveAttempts = () =>
    props.attempts.filter((attempt) => ["admitted", "placing", "running"].includes(attempt.state))
  const previewItems = () => props.items.slice(0, STREAM_CARD_TASK_PREVIEW)
  const hiddenCount = () => Math.max(0, props.items.length - STREAM_CARD_TASK_PREVIEW)
  // The execution target itself is the Project header's job; the card only
  // flags the one actionable problem — a Stream with no usable target.
  const targetMissing = () => {
    const environment = props.stream.executionDefaults.environment
    const revision = props.stream.executionDefaults.repository?.baseRevision
    if (!environment || !revision) return true
    if (environment.kind === "local_worktree" && !environment.directory) return true
    if (environment.kind === "hosted_workspace" && !environment.repositoryUrl) return true
    return false
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
    // Tone (attention/running/paused) renders as the card's left edge accent,
    // driven by data-tone — one quiet signal instead of a second status dot.
    <article class="workgraph-streamcard" data-tone={streamTone()} aria-label={`Stream ${props.stream.title}`}>
      <div class="workgraph-streamcard-head">
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
        {/* Stream actions overlay the title's tail only while the card is
            hovered or focused — at rest the title owns the full card width. */}
        <span class="workgraph-streamcard-actions">
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
        </span>
      </div>
      <div class="workgraph-streamcard-tasks">
        <KeyedById records={previewItems()}>
          {(item) => (
            <WorkItemLeaf item={item()} attempts={props.attempts} client={props.client} mutate={props.mutate} onOpenTask={props.onOpenTask} onOpenSession={props.onOpenSession} />
          )}
        </KeyedById>
        <Show when={!props.items.length}>
          <div class="workgraph-leaf-empty text-text-weaker">No tasks yet.</div>
        </Show>
        {/* Add task reads as one more (demoted) task row at the end of the list. */}
        <div class="workgraph-streamcard-add">
          <InlineAddTask
            streamId={props.stream.id}
            scopeLabel={props.stream.title}
            client={props.client}
            mutate={props.mutate}
          />
        </div>
      </div>
      <Show when={targetMissing()}>
        <div class="workgraph-streamcard-flag" role="note">
          Execution target required
        </div>
      </Show>
      <div class="workgraph-streamcard-foot">
        <span class="text-text-weaker">
          {props.items.length} {props.items.length === 1 ? "task" : "tasks"}
        </span>
        <Show when={liveAttempts().length}>
          <span class="workgraph-running">{liveAttempts().length} running</span>
        </Show>
        <span class="workgraph-streamcard-gap" aria-hidden="true" />
        <Show when={hiddenCount()}>
          <button
            type="button"
            class="workgraph-streamcard-more"
            aria-label={`All tasks for ${props.stream.title}`}
            onClick={() => props.onOpenStreamTasks(props.stream)}
          >
            +{hiddenCount()} more
          </button>
        </Show>
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
    </article>
  )
}

function recapGeneratedLabel(recap: RecapDto, relativeTime: (timestamp: number) => string) {
  const generation = recap.generation
  if (generation.state === "succeeded") return relativeTime(generation.generatedAt)
  if (generation.state === "failed")
    return generation.failedAt ? `failed · ${relativeTime(generation.failedAt)}` : "failed"
  return "invalidated"
}
