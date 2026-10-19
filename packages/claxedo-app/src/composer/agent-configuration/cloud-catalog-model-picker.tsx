import { Match, Show, Switch, createMemo, type JSX } from "solid-js"
import { harnessDisplayLabel } from "@/lib/harness-catalog"
import { Select } from "@/ui"
import { useAgentConfigurationText } from "./i18n"
import { useCloudCatalogModels, type CloudModelChoice, type CloudModelOffer } from "./cloud-catalog-models"
import type { AgentHarnessReference, AgentModelReference } from "./model"

const modelKey = (model: AgentModelReference) => `${model.providerID}/${model.modelID}`

function withSaved(choices: readonly CloudModelChoice[], saved: AgentModelReference | null): CloudModelChoice[] {
  if (!saved || choices.some((choice) => modelKey(choice.model) === modelKey(saved))) return [...choices]
  return [{ model: saved, provider: saved.providerID, name: saved.modelID }, ...choices]
}

export function CloudCatalogModelPicker(props: {
  readonly harness: AgentHarnessReference
  readonly model: AgentModelReference | null
  readonly disabled: boolean
  readonly onModel: (model: AgentModelReference) => void
}): JSX.Element {
  const t = useAgentConfigurationText()
  const models = useCloudCatalogModels(() => props.harness.id)
  const harness = () => harnessDisplayLabel(props.harness.id)
  const failure = () => {
    const state = models()
    return state.kind === "failed" ? state.message : undefined
  }
  const offer = createMemo((): CloudModelOffer | undefined => {
    const state = models()
    return state.kind === "ready" ? state : undefined
  })
  const options = createMemo(() => withSaved(offer()?.choices ?? [], props.model))
  const current = () => options().find((choice) => props.model !== null && modelKey(choice.model) === modelKey(props.model))
  return (
    <Switch>
      <Match when={failure()}>{(message) => <p role="alert" class="text-12-regular text-icon-critical-base">{message()}</p>}</Match>
      <Match when={!offer()}>
        <p class="text-12-regular text-text-weak">{t("agentConfiguration.cloudModelsLoading", { harness: harness() })}</p>
      </Match>
      <Match when={offer()}>
        <Show when={options().length > 0}>
          <Select
            options={options()}
            current={current()}
            value={(choice: CloudModelChoice) => modelKey(choice.model)}
            label={(choice: CloudModelChoice) => choice.name}
            groupBy={(choice: CloudModelChoice) => choice.provider}
            placeholder={t("agentConfiguration.modelPlaceholder")}
            disabled={props.disabled}
            triggerProps={{ "aria-label": t("agentConfiguration.model") }}
            onSelect={(choice) => {
              if (choice) props.onModel(choice.model)
            }}
          />
        </Show>
        <Show when={offer()?.planUnlisted}>
          <p class="text-12-regular text-text-weak">{t("agentConfiguration.cloudPlanUnlisted", { harness: harness() })}</p>
        </Show>
        <Show when={offer()?.choices.length === 0 && !offer()?.planUnlisted}>
          <p role="alert" class="text-12-regular text-icon-critical-base">{t("agentConfiguration.cloudNoAccount", { harness: harness() })}</p>
        </Show>
      </Match>
    </Switch>
  )
}
