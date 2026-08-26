import type { RunDto, OutcomeDto, StreamDto, WorkItemDto } from "@claxedo/workgraph/contracts"
import { Show } from "solid-js"
import type { WorkGraphClient, WorkGraphSessionOpener } from "./api"
import {
  createDependencyResolver,
  InlineAddTask,
  KeyedById,
  OutcomeGroup,
  sortByStatusLabel,
  WorkItemLeaf,
  type Mutate,
} from "./work-item-rows"

/** Full task list for one Stream, rendered inside the shared panel's Tasks tab.
 *  The Stream card previews only the first few tasks; this body shows every
 *  (non-abandoned) task, grouped by Outcome, with the same row affordances. */
export function StreamTasksPanelBody(props: {
  stream: StreamDto
  outcomes: OutcomeDto[]
  items: WorkItemDto[]
  runs: RunDto[]
  client: WorkGraphClient
  mutate: Mutate
  onOpenTask: (item: WorkItemDto, invoker: HTMLElement) => void
  onOpenSession?: WorkGraphSessionOpener
}) {
  // The dependency resolver is built from every task in the Stream (blockers can
  // cross Outcomes), so Waiting vs Ready is correct inside any group.
  const depsComplete = () => createDependencyResolver(props.items)
  const streamPaused = () => props.stream.lifecycleState === "paused"
  // Rows follow the lifecycle order everywhere: needs-you, running, staged, then
  // the ready/waiting queue, then done — inside each outcome group and in the
  // unassigned tail.
  const unassigned = () =>
    sortByStatusLabel(
      props.items.filter((item) => !item.outcomeId),
      depsComplete(),
    )
  const completed = () => props.items.filter((item) => item.state === "completed").length
  return (
    <div class="workgraph-tasks-panel" aria-label={`All tasks for ${props.stream.title}`}>
      <div class="workgraph-tasks-panel-head">
        <span class="text-sm font-semibold text-text-strong">{props.stream.title}</span>
        <Show when={completed()}>
          <span class="text-xs text-text-weaker">{completed()} done</span>
        </Show>
      </div>
      <div class="workgraph-tasks-panel-list">
        <KeyedById records={props.outcomes}>
          {(outcome) => (
            <OutcomeGroup
              outcome={outcome()}
              items={sortByStatusLabel(
                props.items.filter((item) => item.outcomeId === outcome().id),
                depsComplete(),
              )}
              runs={props.runs}
              streamId={props.stream.id}
              client={props.client}
              mutate={props.mutate}
              depsComplete={depsComplete()}
              streamPaused={streamPaused()}
              onOpenSession={props.onOpenSession}
              onOpenTask={props.onOpenTask}
            />
          )}
        </KeyedById>
        <Show when={props.outcomes.length > 0 && unassigned().length}>
          <OutcomeGroup
            items={unassigned()}
            runs={props.runs}
            streamId={props.stream.id}
            client={props.client}
            mutate={props.mutate}
            depsComplete={depsComplete()}
            streamPaused={streamPaused()}
            onOpenSession={props.onOpenSession}
            onOpenTask={props.onOpenTask}
          />
        </Show>
        <Show when={props.outcomes.length === 0}>
          <div class="workgraph-leaves">
            <KeyedById records={unassigned()}>
              {(item) => (
                <WorkItemLeaf
                  item={item()}
                  runs={props.runs}
                  client={props.client}
                  mutate={props.mutate}
                  depsComplete={depsComplete()(item())}
                  streamPaused={streamPaused()}
                  onOpenTask={props.onOpenTask}
                  onOpenSession={props.onOpenSession}
                />
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
    </div>
  )
}
