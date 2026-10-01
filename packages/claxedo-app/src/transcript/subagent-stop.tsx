import { createSignal, Match, Switch } from "solid-js"
import { useData } from "./data"
import { useTranscriptI18n } from "./i18n"

type StopState = { kind: "idle" } | { kind: "stopping" } | { kind: "refused"; message: string }

export function SubagentStopControl(props: { parentSessionId: string; call: string; name: string }) {
  const data = useData()
  const i18n = useTranscriptI18n()
  const [state, setState] = createSignal<StopState>({ kind: "idle" })
  const stop = async (event: MouseEvent) => {
    event.stopPropagation()
    if (!data.stopBackgroundTask || state().kind === "stopping") return
    setState({ kind: "stopping" })
    const answer = await data.stopBackgroundTask(props.parentSessionId, props.call)
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
