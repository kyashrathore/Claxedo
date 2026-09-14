import { createMemo, For, Show } from "solid-js"
import { Icon, type IconProps } from "@opencode-ai/ui/icon"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { TextShimmer } from "@opencode-ai/ui/text-shimmer"
import { useData } from "../context"
import { BasicTool } from "./basic-tool"
import { claxedoToolName, claxedoToolView, taskStatusLabel, type ClaxedoLink } from "./claxedo-tool-view"
import type { ToolProps } from "./message-part"

const STATUS_ICONS: Record<string, IconProps["name"]> = {
  backlog: "circle-dashed",
  todo: "circle",
  doing: "circle-half",
  needs_you: "circle-alert",
  done: "circle-check",
}

/**
 * A link in a tool row: an anchor, so cmd/middle-click reach the browser's own
 * new-tab behaviour, that otherwise hands the open to the surface's navigator
 * when the surface gave one. It stops the click so the row does not toggle.
 */
function CardLink(props: { link: ClaxedoLink; slot: string; class?: string }) {
  const data = useData()
  const href = () =>
    props.link.kind === "task" ? data.taskHref?.(props.link.id) : data.sessionHref?.(props.link.id)
  const navigate = () => (props.link.kind === "task" ? data.navigateToTask : data.navigateToSession)
  const activate = (event: MouseEvent) => {
    event.stopPropagation()
    if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    const go = navigate()
    if (!go) return
    event.preventDefault()
    go(props.link.id)
  }
  return (
    <Show
      when={href()}
      fallback={<span data-slot={props.slot} class={props.class} title={props.link.label}>{props.link.label}</span>}
    >
      {(value) => (
        <a
          data-slot={props.slot}
          data-link-kind={props.link.kind}
          class={props.class}
          href={value()}
          title={props.link.label}
          onClick={activate}
        >
          {props.link.label}
        </a>
      )}
    </Show>
  )
}

function StatusPill(props: { status: string }) {
  const i18n = useI18n()
  return (
    <span data-slot="claxedo-tool-status" data-status={props.status}>
      <Show when={STATUS_ICONS[props.status]}>{(name) => <Icon name={name()} size="small" />}</Show>
      {taskStatusLabel(props.status, i18n)}
    </span>
  )
}

/**
 * One first-party tool call as a transcript row: the Claxedo mark, the verb,
 * the task or session it was about as a link, and its status or outcome. The
 * body holds what the row cannot: a task list, the facts of a start, prose.
 */
export function ClaxedoTool(props: ToolProps) {
  const i18n = useI18n()
  const data = useData()
  const name = createMemo(() => claxedoToolName(props.tool, props.input) ?? props.tool)
  const sessionTitle = (id: string) => data.store.session.find((session) => session.id === id)?.title
  const view = createMemo(() =>
    claxedoToolView({ name: name(), input: props.input, output: props.output, i18n, sessionTitle }),
  )
  const running = () => props.status === "pending" || props.status === "running"
  const hasBody = () => view().facts.length > 0 || view().rows.length > 0 || !!view().text

  const trigger = () => (
    <div data-slot="basic-tool-tool-info-structured">
      <div data-slot="basic-tool-tool-info-main">
        <span data-slot="basic-tool-tool-title">
          <TextShimmer text={view().title} active={running()} />
        </span>
        <Show when={view().link}>
          {(link) => <CardLink link={link()} slot="basic-tool-tool-subtitle" class="subagent-link" />}
        </Show>
        <Show when={view().subject}>
          {(subject) => (
            <span data-slot={view().link ? "basic-tool-tool-arg" : "basic-tool-tool-subtitle"} class={view().link ? "ui-basic-tool-tool-arg" : undefined} title={subject()}>
              {subject()}
            </span>
          )}
        </Show>
        <Show when={view().status}>{(status) => <StatusPill status={status()} />}</Show>
        <Show when={view().note}>
          {(note) => <span data-slot="basic-tool-tool-arg" class="ui-basic-tool-tool-arg">{note()}</span>}
        </Show>
      </div>
    </div>
  )

  return (
    <div data-component="claxedo-tool" data-tool={name()}>
      <BasicTool
        icon="claxedo"
        status={props.status}
        startedAt={props.startedAt}
        hideDetails={props.hideDetails}
        defaultOpen={props.defaultOpen}
        open={props.open}
        onOpenChange={props.onOpenChange}
        trigger={trigger()}
      >
        <Show when={hasBody()}>
          <div data-slot="claxedo-tool-body">
            <Show when={view().rows.length > 0}>
              <ul data-slot="claxedo-tool-rows">
                <For each={view().rows}>
                  {(row) => (
                    <li data-slot="claxedo-tool-row">
                      <CardLink link={row.link} slot="claxedo-tool-row-link" />
                      <Show when={row.status}>{(status) => <StatusPill status={status()} />}</Show>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <Show when={view().more}>{(more) => <span data-slot="claxedo-tool-more">{more()}</span>}</Show>
            <Show when={view().facts.length > 0}>
              <dl data-slot="claxedo-tool-facts">
                <For each={view().facts}>
                  {(fact) => (
                    <div data-slot="claxedo-tool-fact">
                      <dt>{fact.label}</dt>
                      <dd data-mono={fact.mono ? "true" : undefined}>
                        <Show when={fact.link} fallback={fact.value}>
                          {(link) => <CardLink link={link()} slot="claxedo-tool-fact-link" />}
                        </Show>
                      </dd>
                    </div>
                  )}
                </For>
              </dl>
            </Show>
            <Show when={view().text}>
              {(text) => (
                <div data-component="tool-output" data-scrollable tabIndex={0} role="region" aria-label={i18n.t("ui.scrollView.ariaLabel")}>
                  <pre data-slot="claxedo-tool-text">{text()}</pre>
                </div>
              )}
            </Show>
          </div>
        </Show>
      </BasicTool>
    </div>
  )
}
