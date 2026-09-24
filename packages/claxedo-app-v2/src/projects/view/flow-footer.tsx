import { Show, type Component } from "solid-js"
import { Button } from "@/ui"
import type { AddProjectFlow } from "../add-project"
import { useProjectsText } from "../i18n"

export const FlowFooter: Component<{ flow: AddProjectFlow }> = (props) => {
  const t = useProjectsText()
  const state = () => props.flow.state()
  const creating = () => state().kind === "creating"
  const last = () => state().kind === "choosingPlacement" || state().kind === "failed" || creating()
  const failure = () => {
    const current = state()
    return current.kind === "failed" ? current.error : undefined
  }
  const label = () => {
    if (creating()) return t("projects.add.creating")
    if (!last()) return t("projects.add.next")
    return failure() ? t("projects.add.retry") : t("projects.add.create")
  }

  return (
    <div class="projects-footer" data-slot="add-project-footer">
      <p
        class="m-0 min-w-0 flex-1"
        classList={{ "projects-alert": Boolean(failure()), "projects-hint": !failure() }}
        role={failure() ? "alert" : undefined}
        data-slot="add-project-reason"
      >
        <Show when={failure()}>{(error) => `${t("projects.add.failed")}: ${error().message}`}</Show>
      </p>
      <div class="flex shrink-0 items-center gap-2">
        <Show when={state().kind !== "choosingSource"}>
          <Button variant="ghost" size="large" onClick={() => props.flow.back()} disabled={creating()}>
            {t("projects.add.back")}
          </Button>
        </Show>
        <Show when={state().kind === "choosingAgent"}>
          <Button variant="ghost" size="large" onClick={() => props.flow.skipAgent()}>
            {t("projects.add.agent.skip")}
          </Button>
        </Show>
        <Button variant="contrast" size="large" disabled={!props.flow.canAdvance() || creating()} onClick={() => void props.flow.next()}>
          {label()}
        </Button>
      </div>
    </div>
  )
}
