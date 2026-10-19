import { createMemo, For, Show } from "solid-js"
import { TextShimmer } from "@/ui"
import { SurfaceIcon } from "@/surface"
import { useTranscriptI18n } from "./i18n"
import { useData } from "./data"
import { BasicTool } from "./basic-tool"
import { claxedoToolName } from "@claxedo/agent-runtime-contract"
import { claxedoToolView } from "./claxedo-tool-view"
import { claxedoLinkHref, type ClaxedoLink, type ClaxedoStatus } from "./tool-card-template"
import { safeLinkHref } from "./safe-link"
import type { ToolProps } from "./message-part"

function CardLink(props: { link: ClaxedoLink; slot: "basic-tool-tool-subtitle" | "claxedo-tool-row-link" | "claxedo-tool-fact-link"; class?: string }) {
  const data = useData()
  const href = () => safeLinkHref(claxedoLinkHref(props.link, data.sessionHref))
  const activate = (event: MouseEvent) => {
    event.stopPropagation()
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

function StatusPill(props: { status: ClaxedoStatus }) {
  return (
    <span data-slot="claxedo-tool-status" data-tone={props.status.tone}>
      <Show when={props.status.icon}>{(name) => <SurfaceIcon name={name()} size="small" />}</Show>
      {props.status.label}
    </span>
  )
}

export function ClaxedoTool(props: ToolProps) {
  const i18n = useTranscriptI18n()
  const data = useData()
  const name = createMemo(() => claxedoToolName(props.tool, props.input) ?? props.tool)
  const view = createMemo(() =>
    claxedoToolView({ name: name(), input: props.input, output: props.output, i18n, toolCards: data.toolCards() }),
  )
  const href = () => safeLinkHref(data.claxedoToolHref?.(name(), props.input, props.output))
  const running = () => props.status === "pending" || props.status === "running"
  const hasBody = () => view().facts.length > 0 || view().rows.length > 0 || !!view().text

  const trigger = () => (
    <div data-slot="basic-tool-tool-info-structured">
      <div data-slot="basic-tool-tool-info-main">
        <span data-slot="basic-tool-tool-title">
          <Show when={href()} fallback={<TextShimmer text={view().title} active={running()} />}>
            {(url) => <a href={url()} class="subagent-link" data-link-kind="claxedo-tool" onClick={(event) => event.stopPropagation()}><TextShimmer text={view().title} active={running()} /></a>}
          </Show>
        </span>
        <Show when={view().link}>
          {(link) => <CardLink link={link()} slot="basic-tool-tool-subtitle" class="subagent-link" />}
        </Show>
        <Show when={view().subject}>
          {(subject) => (
            <span data-slot={view().link ? undefined : "basic-tool-tool-subtitle"} class={view().link ? "ui-basic-tool-tool-arg" : undefined} title={subject()}>
              {subject()}
            </span>
          )}
        </Show>
        <Show when={view().status}>{(status) => <StatusPill status={status()} />}</Show>
        <Show when={view().note}>
          {(note) => <span class="ui-basic-tool-tool-arg">{note()}</span>}
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
        bodyPending={props.bodyPending}
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
                <div data-component="tool-output" data-scrollable tabIndex={0} role="region" aria-label={i18n.t("transcript.scrollView.ariaLabel")}>
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
