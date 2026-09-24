import { Show, type Component } from "solid-js"
import type { AddProjectFlow } from "../add-project"
import { projectsText } from "../i18n"
import { buttonAttrs } from "./button-attrs"

export const FlowFooter: Component<{ flow: AddProjectFlow }> = (props) => {
  const state = () => props.flow.state()
  const creating = () => state().kind === "creating"
  const last = () => state().kind === "choosingPlacement" || state().kind === "failed" || creating()
  const failure = () => {
    const current = state()
    return current.kind === "failed" ? current.error : undefined
  }

  return (
    <div class="mt-4 flex shrink-0 flex-wrap items-center gap-3 border-t pt-4" style={{ "border-color": "var(--v2-border-border-base)" }} data-slot="add-project-footer">
      <p class="min-w-0 flex-1" classList={{ "projects-alert": Boolean(failure()), "projects-hint": !failure() }} role={failure() ? "alert" : undefined} data-slot="add-project-reason">
        <Show when={failure()}>{(error) => `${projectsText("projects.add.failed")}: ${error().message}`}</Show>
      </p>
      <div class="flex shrink-0 items-center gap-2">
        <Show when={state().kind !== "choosingSource"}>
          <button type="button" {...buttonAttrs("ghost")} onClick={() => props.flow.back()} disabled={creating()}>
            {projectsText("projects.add.back")}
          </button>
        </Show>
        <Show when={state().kind === "choosingAgent"}>
          <button type="button" {...buttonAttrs("ghost")} onClick={() => props.flow.skipAgent()}>
            {projectsText("projects.add.agent.skip")}
          </button>
        </Show>
        <button
          type="button"
          {...buttonAttrs("contrast")}
          disabled={!props.flow.canAdvance() || creating()}
          onClick={() => void props.flow.next()}
        >
          <Show when={last()} fallback={projectsText("projects.add.next")}>
            <Show when={creating()} fallback={failure() ? projectsText("projects.add.retry") : projectsText("projects.add.create")}>
              {projectsText("projects.add.creating")}
            </Show>
          </Show>
        </button>
      </div>
    </div>
  )
}
