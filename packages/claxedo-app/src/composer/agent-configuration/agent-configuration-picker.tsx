import { Show, untrack, type JSX } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useServer } from "@/server"
import { useAgentConfigurationText } from "./i18n"
import { DraftHarnessPicker } from "../view/draft-harness-picker"
import { CloudConfigurationPicker } from "./cloud-configuration-picker"
import { configurationOf, harnessChoiceOf, rebaseConfiguration, type AgentConfiguration, type AgentPlacement } from "./model"

export type AgentConfigurationPickerProps = {
  readonly placement: AgentPlacement
  readonly value: AgentConfiguration
  readonly disabled: boolean
  readonly onChange: (value: AgentConfiguration) => void
}

type PickerProps = { readonly configuration: AgentConfiguration; readonly disabled: boolean; readonly onChange: (value: AgentConfiguration) => void }

function LocalConfigurationPicker(props: PickerProps): JSX.Element {
  const t = useAgentConfigurationText()
  const server = useServer()
  const placements = useQuery(() => server.queries.placements.list())
  const placement = () => placements.data?.[0]?.id
  return (
    <Show
      when={placement()}
      fallback={
        <p class="text-12-regular text-text-weak">
          {placements.isPending ? t("agentConfiguration.loadingProjects") : t("agentConfiguration.addProjectFirst")}
        </p>
      }
    >
      {(placementId) => (
        <DraftHarnessPicker
          placementId={placementId()}
          seed={harnessChoiceOf(props.configuration)}
          active={!props.disabled}
          onChange={(choice) => props.onChange(configurationOf(choice))}
        />
      )}
    </Show>
  )
}

export function AgentConfigurationPicker(props: AgentConfigurationPickerProps): JSX.Element {
  const change = (next: AgentConfiguration) => props.onChange(rebaseConfiguration(untrack(() => props.value), next))
  return (
    <Show when={props.placement === "cloud"} fallback={<LocalConfigurationPicker configuration={props.value} disabled={props.disabled} onChange={change} />}>
      <CloudConfigurationPicker configuration={props.value} disabled={props.disabled} onChange={change} />
    </Show>
  )
}
