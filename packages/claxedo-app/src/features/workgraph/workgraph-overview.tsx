import type {
  AttemptDto,
  OutcomeDto,
  StreamDto,
  WorkItemDto,
} from "@claxedo/workgraph/contracts"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Popover } from "@opencode-ai/ui/popover"
import { createSignal, For, type JSX, Show } from "solid-js"
import { SemanticIcon } from "@/ui/semantic-icon"
import type { WorkGraphClient, WorkGraphSessionOpener } from "./api"
import { createDependencyResolver, InlineAddTask, isRetryable, KeyedById, sortByStatusLabel, taskStatusLabel, type TaskStatusLabel, WorkItemLeaf, type Mutate } from "./work-item-rows"

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
  return (
    <section class="workgraph-project" aria-label={`Project ${props.project.label}`}>
      {/* The header is a quiet label, not a signal: attention belongs to the
          cards below, which name the stream that actually needs you. */}
      <div class="workgraph-project-row">
        <SemanticIcon concept="project" size="small" class="workgraph-project-icon" />
        <span class="workgraph-project-name text-text-strong">{props.project.label}</span>
        <Show when={props.project.detail}>
          <span class="workgraph-project-path text-text-weaker">{props.project.detail}</span>
        </Show>
      </div>
      <div class="workgraph-project-cards">
        <button
          type="button"
          class="workgraph-streamcard-new"
          aria-label={`New stream in ${props.project.label}`}
          onClick={() => props.onNewStream(props.project)}
        >
          <Icon name="plus-small" size="small" />
          New stream
        </button>
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
  const depsComplete = () => createDependencyResolver(props.items)
  const streamPaused = () => props.stream.lifecycleState === "paused"
  // The preview honors the lifecycle: what needs you first, then running work,
  // then the staged queue, ready/waiting, with done tasks last (first to clip).
  const previewItems = () => sortByStatusLabel(props.items, depsComplete()).slice(0, STREAM_CARD_TASK_PREVIEW)
  const hiddenCount = () => Math.max(0, props.items.length - STREAM_CARD_TASK_PREVIEW)
  const statusCounts = () => {
    const resolve = depsComplete()
    const counts: Record<TaskStatusLabel, number> = { staged: 0, ready: 0, waiting: 0, running: 0, "needs-you": 0, done: 0 }
    for (const item of props.items) counts[taskStatusLabel(item.state, resolve(item))] += 1
    return counts
  }
  const total = () => props.items.length
  const doneCount = () => statusCounts().done
  // Both Staged (awaiting approval) and Needs-you (attention) block on the owner,
  // so the card face folds them into one "N need you" pill.
  const needYou = () => statusCounts().staged + statusCounts()["needs-you"]
  // The full breakdown — staged · ready · waiting · running · needs you · done,
  // zero segments omitted — rides folded behind the stack glyph on the 267px
  // footer and fans out on hover; the pill and fraction stay always-visible.
  const breakdown = () => {
    const counts = statusCounts()
    return (
      [
        counts.staged ? `${counts.staged} staged` : "",
        counts.ready ? `${counts.ready} ready` : "",
        counts.waiting ? `${counts.waiting} waiting` : "",
        counts.running ? `${counts.running} running` : "",
        counts["needs-you"] ? `${counts["needs-you"]} needs you` : "",
        counts.done ? `${counts.done} done` : "",
      ] as const
    ).filter(Boolean) as string[]
  }
  const needsYouLabel = () => `${needYou()} need you`
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
  const [confirming, setConfirming] = createSignal(false)
  const [removing, setRemoving] = createSignal(false)
  // Hover and focus fan the lifecycle rows open through CSS alone; this only
  // carries the tap/click path, where there is no hover to rely on.
  const [fanOpen, setFanOpen] = createSignal(false)
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
  const [retrying, setRetrying] = createSignal(false)
  const [pausing, setPausing] = createSignal(false)
  const retryableItems = () =>
    props.stream.lifecycleState === "active"
      ? props.items.filter((item) => isRetryable(item, props.attempts))
      : []
  // Launch is automatic and continuous: the only launch control is the Stream's
  // lifecycle. Pausing stops new admissions (running attempts continue);
  // resuming re-arms the drain, which launches every approved, ready task.
  const canPauseResume = () => props.stream.lifecycleState === "active" || props.stream.lifecycleState === "paused"
  const togglePause = async (event: MouseEvent) => {
    event.stopPropagation()
    if (pausing() || !canPauseResume()) return
    setPausing(true)
    try {
      const paused = streamPaused()
      await props.mutate(() =>
        props.client.setStreamLifecycle({
          streamId: props.stream.id,
          expectedVersion: props.stream.version,
          state: paused ? "active" : "paused",
          reason: paused ? "Resumed from overview" : "Paused from overview",
        }),
      )
    } finally {
      setPausing(false)
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
    <article class="workgraph-streamcard" aria-label={`Stream ${props.stream.title}`}>
      <div class="workgraph-streamcard-head">
        <span class="workgraph-stream-title">{props.stream.title}</span>
        {/* Fixed controls stay in normal layout flow so every hit target remains
            available and the title wraps around their reserved width. */}
        <span class="workgraph-streamcard-actions">
        <Show when={canPauseResume()}>
          <button
            type="button"
            class="workgraph-row-settings"
            classList={{ "is-active": streamPaused() }}
            aria-label={`${streamPaused() ? "Resume" : "Pause"} stream ${props.stream.title}`}
            aria-pressed={streamPaused()}
            title="Stop launching new tasks. Running tasks continue."
            disabled={pausing()}
            onClick={(event) => void togglePause(event)}
          >
            <Icon name={streamPaused() ? "console" : "circle-half"} size="small" />
          </button>
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
            <WorkItemLeaf item={item()} attempts={props.attempts} client={props.client} mutate={props.mutate} depsComplete={depsComplete()(item())} streamPaused={streamPaused()} onOpenTask={props.onOpenTask} onOpenSession={props.onOpenSession} />
          )}
        </KeyedById>
        <Show when={!props.items.length}>
          <div class="workgraph-leaf-empty text-text-weaker">No tasks yet.</div>
        </Show>
        {/* The tail of the same list, so the overflow reads as "the list keeps
            going" rather than a footer statistic. */}
        <Show when={hiddenCount()}>
          <button
            type="button"
            class="workgraph-streamcard-more"
            aria-label={`All tasks for ${props.stream.title}`}
            onClick={() => props.onOpenStreamTasks(props.stream)}
          >
            Show {hiddenCount()} more
          </button>
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
      {/* --fan-count rides the footer because two things need it: the rows'
          closing stagger, and the mask that hides the list strip they cover. */}
      <div class="workgraph-streamcard-foot" style={{ "--fan-count": `${breakdown().length}` }}>
        {/* The full breakdown folds into one glyph + done/total fraction; hover,
            focus, or tap splits it into a row per non-empty segment, each fanning
            up off the button. The rows are decoration — the button's label
            carries the same breakdown for screen readers. */}
        <Show when={breakdown().length}>
          <div class="workgraph-streamcard-lifecycle">
            <button
              type="button"
              class="workgraph-streamcard-stack"
              aria-label={`Task breakdown for ${props.stream.title}: ${breakdown().join(", ")}`}
              aria-expanded={fanOpen()}
              data-open={fanOpen() ? "" : undefined}
              onClick={(event) => {
                event.stopPropagation()
                setFanOpen((open) => !open)
              }}
              onBlur={() => setFanOpen(false)}
            >
              {/* A chevron claims nothing except the direction the fan opens.
                  The done/total fraction beside it is the always-visible face. */}
              <Icon name="chevron-down" size="small" class="workgraph-streamcard-stack-chevron" />
              <span class="workgraph-streamcard-stack-count">{doneCount()}/{total()}</span>
            </button>
            <span class="workgraph-streamcard-fan" aria-hidden="true">
              <For each={breakdown()}>
                {(row, index) => (
                  <span
                    class="workgraph-streamcard-fan-row"
                    style={{ "--fan-slot": `${breakdown().length - index()}` }}
                  >
                    {row}
                  </span>
                )}
              </For>
            </span>
          </div>
        </Show>
        {/* A paused Stream is now load-bearing (it stops launches), so the face
            names it plainly next to the fraction. */}
        <Show when={streamPaused()}>
          <span class="workgraph-streamcard-paused text-text-weaker">Paused</span>
        </Show>
        {/* Needs-you sits with the lifecycle, not across the card from it: it is
            the same fact — where the work stands. Staged + attention both block
            on the owner, so they fold into one always-visible pill. */}
        <Show when={needYou()}>
          <span class="workgraph-streamcard-needs-you">{needsYouLabel()}</span>
        </Show>
        <span class="workgraph-streamcard-gap" aria-hidden="true" />
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
