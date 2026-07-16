import type { AttemptDto, OutcomeDto, StreamDto, WorkItemDto } from "@claxedo/workgraph/contracts"
import { Show } from "solid-js"
import type { WorkGraphClient, WorkGraphSessionOpener } from "./api"
import { InlineAddTask, KeyedById, OutcomeGroup, sortByStatusBucket, WorkItemLeaf, type Mutate } from "./work-item-rows"

/** Full task list for one Stream, rendered inside the shared panel's Tasks tab.
 *  The Stream card previews only the first few tasks; this body shows every
 *  (non-abandoned) task, grouped by Outcome, with the same row affordances. */
export function StreamTasksPanelBody(props: {
  stream: StreamDto
  outcomes: OutcomeDto[]
  items: WorkItemDto[]
  attempts: AttemptDto[]
  client: WorkGraphClient
  mutate: Mutate
  onOpenTask: (item: WorkItemDto, invoker: HTMLElement) => void
  onOpenSession?: WorkGraphSessionOpener
}) {
  // Rows follow the lifecycle order everywhere: needs-you, in progress,
  // staged, done — inside each outcome group and in the unassigned tail.
  const unassigned = () => sortByStatusBucket(props.items.filter((item) => !item.outcomeId))
  const completed = () => props.items.filter((item) => item.state === "completed").length
  return (
    <div class="workgraph-tasks-panel" aria-label={`All tasks for ${props.stream.title}`}>
      <div class="workgraph-tasks-panel-head">
        <span class="text-[12px] font-semibold text-text-strong">{props.stream.title}</span>
        <span class="workgraph-count" aria-label={`${props.items.length} tasks`}>{props.items.length}</span>
        <Show when={completed()}>
          <span class="text-[11px] text-text-weaker">{completed()} done</span>
        </Show>
      </div>
      <div class="workgraph-tasks-panel-list">
        <KeyedById records={props.outcomes}>
          {(outcome) => (
            <OutcomeGroup
              outcome={outcome()}
              items={sortByStatusBucket(props.items.filter((item) => item.outcomeId === outcome().id))}
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
          <div class="workgraph-leaves">
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
    </div>
  )
}
