import { For, Show, type Component } from "solid-js"
import { RadioGroup, RadioItem } from "@/ui"
import type { AddProjectFlow } from "../add-project"
import { useProjectsText, type ProjectsText } from "../i18n"
import { choiceKey, optionChoice, type PlacementOption } from "../placement-options"

function optionTitle(t: ProjectsText, option: PlacementOption): string {
  if (option.kind === "cloud") return t("projects.add.placement.cloud")
  const title = option.machine.isThisMachine ? t("projects.add.placement.thisMachine") : option.machine.name
  return option.machine.online ? title : `${title} (${t("projects.add.placement.offline")})`
}

function optionDetail(t: ProjectsText, option: PlacementOption, folderSource: boolean): string {
  if (option.kind === "cloud") return t("projects.add.placement.cloud.hint")
  if (option.machine.isThisMachine) return t("projects.add.placement.thisMachine.hint")
  const reason = folderSource ? t("projects.add.placement.folderNeedsMachine") : t("projects.add.placement.machine.unavailable")
  return `${t("projects.add.placement.machine.hint")} ${reason}`
}

export const PlacementStep: Component<{ flow: AddProjectFlow }> = (props) => {
  const t = useProjectsText()
  const folderSource = () => props.flow.draft.source?.kind === "folder"
  const selected = () => {
    const choice = props.flow.placement()
    return choice ? choiceKey(choice) : ""
  }
  const choose = (key: string) => {
    const option = props.flow.placementOptions().find((candidate) => candidate.key === key)
    if (option) props.flow.setDraft("placement", optionChoice(option))
  }

  return (
    <div class="flex flex-col gap-3" data-slot="placement-step">
      <RadioGroup class="projects-choices" aria-label={t("projects.add.placement.title")} value={selected()} onChange={choose}>
        <For each={props.flow.placementOptions()}>
          {(option) => (
            <RadioItem
              value={option.key}
              label={optionTitle(t, option)}
              description={optionDetail(t, option, folderSource())}
              disabled={!option.selectable}
              data-placement={option.key}
            />
          )}
        </For>
      </RadioGroup>
      <Show when={props.flow.placementOptions().every((option) => !option.selectable)}>
        <p class="projects-hint m-0">{t("projects.add.placement.empty")}</p>
      </Show>
    </div>
  )
}
