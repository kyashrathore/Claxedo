import { Match, Show, Switch, createMemo, type JSX } from "solid-js"
import type { ConfigurationSlot, HarnessReference, ModelReference } from "@claxedo/tasks"
import { useTranslator } from "@/i18n"
import { harnessDisplayLabel } from "@/lib/harness-catalog"
import { Select } from "@/ui"
import { tasksDictionary } from "../i18n"
import { useCloudCatalogModels, type CloudModelChoice, type CloudModelOffer } from "./cloud-catalog-models"

const modelKey = (model: ModelReference) => `${model.providerID}/${model.modelID}`

function withSaved(choices: readonly CloudModelChoice[], saved: ModelReference | null): CloudModelChoice[] {
  if (!saved || choices.some((choice) => modelKey(choice.model) === modelKey(saved))) return [...choices]
  return [{ model: saved, provider: saved.providerID, name: saved.modelID }, ...choices]
}

export function CloudCatalogModelPicker(props: {
  readonly slot: ConfigurationSlot
  readonly harness: HarnessReference
  readonly model: ModelReference | null
  readonly disabled: boolean
  readonly onModel: (model: ModelReference) => void
}): JSX.Element {
  const t = useTranslator(tasksDictionary)
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
  const hint = `preset-cloud-models-${props.slot}`
  return (
    <Switch>
      <Match when={failure()}>{(message) => <p class="tsk-error" data-testid={hint}>{message()}</p>}</Match>
      <Match when={!offer()}>
        <p class="tsk-hint" data-testid={hint}>{t("tasks.preset.cloudModelsLoading", { harness: harness() })}</p>
      </Match>
      <Match when={offer()}>
        <Show when={options().length > 0}>
          <Select
            options={options()}
            current={current()}
            value={(choice: CloudModelChoice) => modelKey(choice.model)}
            label={(choice: CloudModelChoice) => choice.name}
            groupBy={(choice: CloudModelChoice) => choice.provider}
            placeholder={t("tasks.preset.modelPlaceholder")}
            disabled={props.disabled}
            triggerProps={{ "data-testid": `preset-cloud-model-picker-${props.slot}`, "aria-label": t("tasks.preset.model") }}
            onSelect={(choice) => {
              if (choice) props.onModel(choice.model)
            }}
          />
        </Show>
        <Show when={offer()?.planUnlisted}>
          <p class="tsk-hint" data-testid={`preset-cloud-plan-${props.slot}`}>{t("tasks.preset.cloudPlanUnlisted", { harness: harness() })}</p>
        </Show>
        <Show when={offer()?.choices.length === 0 && !offer()?.planUnlisted}>
          <p class="tsk-error" data-testid={hint}>{t("tasks.preset.cloudNoAccount", { harness: harness() })}</p>
        </Show>
      </Match>
    </Switch>
  )
}
