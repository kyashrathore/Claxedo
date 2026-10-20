import { createMemo, For, Show, type JSX } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { persistedSignal, preferenceKey } from "@/lib/persisted"
import { useServer } from "@/server"
import { SubagentStopControl } from "@/transcript"
import { ClaxedoIcon as Icon } from "@/ui"
import type { SessionView } from "@/session"
import { useSessionScreenText } from "../text"
import { runsInBackground } from "../subagent-views"
import { backgroundTasks, type BackgroundTasks } from "./background"
import { DetailsCard, DetailsRow } from "./details-card"
import { useDetailsText, type DetailsText } from "./i18n"

const readOpen = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined)

function CountRows(props: { readonly tasks: BackgroundTasks; readonly t: DetailsText }): JSX.Element {
  const count = (kind: "agents" | "shells" | "other", value: number) =>
    props.t(`details.background.${kind}.${value === 1 ? "one" : "other"}`, { count: value })
  return (
    <>
      <Show when={props.tasks.unlistedAgents > 0}>
        <DetailsRow icon="subagent">{count("agents", props.tasks.unlistedAgents)}</DetailsRow>
      </Show>
      <Show when={props.tasks.shells > 0}>
        <DetailsRow icon="terminal">{count("shells", props.tasks.shells)}</DetailsRow>
      </Show>
      <Show when={props.tasks.other > 0}>
        <DetailsRow icon="task">{count("other", props.tasks.other)}</DetailsRow>
      </Show>
    </>
  )
}

export function BackgroundCard(props: { readonly view: SessionView }): JSX.Element {
  const t = useDetailsText()
  const screen = useSessionScreenText()
  const server = useServer()
  const [open, setOpen] = persistedSignal(preferenceKey("session", "details", "backgroundOpen"), false, readOpen)
  const listed = createMemo(() => props.view.subagents().some(runsInBackground))
  const stops = useQuery(() => ({ ...server.queries.harnesses.stopsBackgroundTasks(props.view.ref), enabled: listed() }))
  const tasks = createMemo(() =>
    backgroundTasks({
      work: props.view.backgroundWork(),
      subagents: props.view.subagents(),
      sessionId: props.view.ref.sessionId,
      labels: { subagent: screen("sessionScreen.subagent.label"), task: screen("sessionScreen.subagent.task") },
      stops: stops.data === true,
    }),
  )
  const running = () => tasks().running > 0
  const stop = (call: string) => async () => {
    const answer = await server.sessions.stopBackgroundTask(props.view.ref, call)
    return answer.ok ? answer : { ok: false as const, message: answer.message }
  }
  const title = (
    <button
      type="button"
      data-slot="details-background-toggle"
      class="flex h-6 min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default"
      aria-expanded={running() && open()}
      aria-label={t(open() ? "details.background.hide" : "details.background.show")}
      disabled={!running()}
      onClick={() => setOpen(!open())}
    >
      <span class="flex-1 truncate">{t("details.background")}</span>
      <span data-slot="details-background-summary" class="shrink-0">
        {running() ? t("details.background.running", { count: tasks().running }) : t("details.background.none")}
      </span>
      <Show when={running()}>
        <Icon name="chevron-down" size="small" class="shrink-0 transition-transform duration-100" classList={{ "rotate-180": open() }} />
      </Show>
    </button>
  )
  return (
    <DetailsCard slot="details-background" title={title}>
      <Show when={running() && open()}>
        <div data-slot="details-background-list" class="mt-1.5 border-t border-border-weaker-base pt-1.5">
          <For each={tasks().agents}>
            {(agent) => (
              <DetailsRow icon="subagent" title={agent.description}>
                <span class="min-w-0 flex-1 truncate">{agent.label}</span>
                <Show when={agent.stopCall}>{(call) => <SubagentStopControl stop={stop(call())} name={agent.label} />}</Show>
              </DetailsRow>
            )}
          </For>
          <CountRows tasks={tasks()} t={t} />
        </div>
      </Show>
    </DetailsCard>
  )
}
