import { Match, Show, Switch } from "solid-js"
import { Button, ClaxedoIcon } from "@/ui"
import { useSessionScreenText } from "../text"
import { STILL_STARTING } from "./model"
import type { WorkspaceStart } from "./start-workspace"
import { StartupSteps } from "./startup-steps"
import { WorkspaceStateNote, WorkspaceStateShell } from "./workspace-state-shell"

export function WorkspaceStartView(props: { readonly start: WorkspaceStart }) {
  const t = useSessionScreenText()
  const state = () => props.start.state()
  const eyebrow = () => t("sessionScreen.workspace.eyebrow")
  const starting = () => {
    const current = state()
    return current.kind === "starting" ? current : undefined
  }
  const failure = () => {
    const current = state()
    return current.kind === "failed" ? current.error : undefined
  }
  const stillStarting = () => failure()?.code === STILL_STARTING
  return (
    <Switch>
      <Match when={starting()}>
        {(current) => (
          <WorkspaceStateShell
            label={t("sessionScreen.workspace.starting.title")}
            eyebrow={eyebrow()}
            title={t("sessionScreen.workspace.starting.title")}
            detail={t("sessionScreen.workspace.starting.detail")}
          >
            <StartupSteps t={t} bootMode={current().bootMode} />
          </WorkspaceStateShell>
        )}
      </Match>
      <Match when={failure()}>
        {(error) => (
          <WorkspaceStateShell
            label={t(stillStarting() ? "sessionScreen.workspace.stillStarting.title" : "sessionScreen.workspace.failed.title")}
            tone="critical"
            eyebrow={eyebrow()}
            title={t(stillStarting() ? "sessionScreen.workspace.stillStarting.title" : "sessionScreen.workspace.failed.title")}
            detail={t(stillStarting() ? "sessionScreen.workspace.stillStarting.detail" : "sessionScreen.workspace.failed.detail")}
            actions={<Button variant="primary" onClick={() => void props.start.start()}>{t("sessionScreen.action.retry")}</Button>}
          >
            <Show when={!stillStarting()}>
              <WorkspaceStateNote>
                <ClaxedoIcon name="warning" size="small" class="translate-y-px shrink-0 text-icon-base" />
                <span class="min-w-0 break-words font-mono text-xs leading-5 text-text-strong">{error().message}</span>
              </WorkspaceStateNote>
            </Show>
          </WorkspaceStateShell>
        )}
      </Match>
      <Match when={state().kind === "stopped"}>
        <WorkspaceStateShell
          label={t("sessionScreen.workspace.stopped.title")}
          eyebrow={eyebrow()}
          title={t("sessionScreen.workspace.stopped.title")}
          detail={t("sessionScreen.workspace.stopped.detail")}
          actions={<Button variant="primary" onClick={() => void props.start.start()}>{t("sessionScreen.workspace.stopped.start")}</Button>}
        />
      </Match>
    </Switch>
  )
}
