import { For, Show, type Component } from "solid-js"
import { A } from "@solidjs/router"
import { useProjectsServer } from "../api"
import type { AddProjectFlow } from "../add-project"
import { projectsText } from "../i18n"
import { settingsAccountsPath } from "../routes"

export const AgentStep: Component<{ flow: AddProjectFlow }> = (props) => {
  const server = useProjectsServer()
  const harnesses = () => server.capabilities()?.harnesses ?? []

  return (
    <div class="flex flex-col gap-3" data-slot="agent-step">
      <div role="radiogroup" aria-label={projectsText("projects.add.agent.title")} class="flex flex-col gap-2">
        <For each={harnesses()}>
          {(harness) => (
            <button
              type="button"
              role="radio"
              class="projects-choice"
              aria-checked={props.flow.draft.harnessId === harness.id}
              data-harness={harness.id}
              onClick={() => props.flow.setDraft("harnessId", harness.id)}
            >
              <span class="projects-choice-title">{harness.name}</span>
              <span class="projects-choice-detail" data-available={harness.available}>
                {harness.available ? projectsText("projects.add.agent.ready") : projectsText("projects.add.agent.unavailable")}
              </span>
            </button>
          )}
        </For>
      </div>
      <Show when={harnesses().length === 0}>
        <p class="projects-hint">{projectsText("projects.add.agent.empty")}</p>
      </Show>
      <A href={settingsAccountsPath} class="projects-hint min-h-11 self-start underline underline-offset-2">
        {projectsText("projects.add.agent.settings")}
      </A>
    </div>
  )
}
