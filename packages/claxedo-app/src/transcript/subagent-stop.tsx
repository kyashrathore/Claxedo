import { createSignal, Match, Switch } from "solid-js"
import type { SubagentStopAnswer } from "./data"
import { useTranscriptI18n } from "./i18n"

type StopState = { kind: "idle" } | { kind: "stopping" } | { kind: "refused"; message: string }

export function SubagentStopControl(props: { stop: () => Promise<SubagentStopAnswer>; name: string }) {
  const i18n = useTranscriptI18n()
  const [state, setState] = createSignal<StopState>({ kind: "idle" })
  const stop = async (event: MouseEvent) => {
    event.stopPropagation()
    if (state().kind === "stopping") return
    setState({ kind: "stopping" })
    const answer = await props.stop()
      .catch((error: unknown) => ({ ok: false as const, message: error instanceof Error ? error.message : String(error) }))
    if (!answer.ok) setState({ kind: "refused", message: answer.message })
  }
  return (
    <span data-slot="subagent-stop" data-state={state().kind}>
      <Switch>
        <Match when={state().kind === "stopping"}>
          <span data-slot="subagent-stop-progress" role="status">{i18n.t("transcript.subagent.stopping")}</span>
        </Match>
        <Match when={state().kind !== "stopping"}>
          <button type="button" data-action="subagent-stop" aria-label={i18n.t("transcript.subagent.stopLabel", { name: props.name })} onClick={stop}>
            {i18n.t("transcript.subagent.stop")}
          </button>
        </Match>
      </Switch>
      {(() => {
        const current = state()
        return current.kind === "refused" ? <span data-slot="subagent-stop-refused" role="status">{current.message}</span> : null
      })()}
    </span>
  )
}
