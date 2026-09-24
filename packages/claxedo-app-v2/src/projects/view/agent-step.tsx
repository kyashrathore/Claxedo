import { For, Show, type Component } from "solid-js"
import { A } from "@solidjs/router"
import { useServer } from "@/server"
import { RadioGroup, RadioItem } from "@/ui"
import type { AddProjectFlow } from "../add-project"
import { useProjectsText } from "../i18n"
import { settingsAccountsPath } from "../routes"

export const AgentStep: Component<{ flow: AddProjectFlow }> = (props) => {
  const t = useProjectsText()
  const server = useServer()
  const harnesses = () => server.capabilities()?.harnesses ?? []

  return (
    <div class="flex flex-col gap-3" data-slot="agent-step">
      <RadioGroup
        class="projects-choices"
        aria-label={t("projects.add.agent.title")}
        value={props.flow.draft.harnessId ?? ""}
        onChange={(harnessId) => props.flow.setDraft("harnessId", harnessId)}
      >
        <For each={harnesses()}>
          {(harness) => (
            <RadioItem
              value={harness.id}
              label={harness.name}
              description={harness.available ? t("projects.add.agent.ready") : t("projects.add.agent.unavailable")}
              disabled={!harness.available}
              data-harness={harness.id}
              data-available={harness.available}
            />
          )}
        </For>
      </RadioGroup>
      <Show when={harnesses().length === 0}>
        <p class="projects-hint m-0">{t("projects.add.agent.empty")}</p>
      </Show>
      <A href={settingsAccountsPath} class="projects-link">
        {t("projects.add.agent.settings")}
      </A>
    </div>
  )
}
