import { Show, onMount, type JSX } from "solid-js"
import type { ConfigurationSlot, HarnessReference } from "@claxedo/tasks"
import { useTranslator } from "@/i18n"
import { harnessDisplayLabel } from "@/lib/harness-catalog"
import { NATIVE_HARNESS_IDS } from "@/lib/harness-selection"
import { Select } from "@/ui"
import { tasksDictionary } from "../i18n"
import { cloudConfiguration, cloudPresetModel, isCloudPresetModel } from "./cloud-model"
import type { ConfigurationDraft } from "./draft"

const CLOUD_HARNESSES: readonly HarnessReference[] = NATIVE_HARNESS_IDS.map((id) => ({ id, access: "native" }))

function CloudModelNote(props: { readonly configuration: ConfigurationDraft; readonly slot: ConfigurationSlot }): JSX.Element {
  const t = useTranslator(tasksDictionary)
  const harness = () => harnessDisplayLabel(props.configuration.harness?.id ?? "")
  return (
    <Show when={props.configuration.model}>
      {(model) => (
        <p class="tsk-hint" data-testid={`preset-cloud-model-${props.slot}`}>
          {isCloudPresetModel(props.configuration)
            ? t("tasks.preset.cloudDefaultModel", { harness: harness() })
            : t("tasks.preset.cloudSavedModel", { model: model().modelID })}
        </p>
      )}
    </Show>
  )
}

export function CloudConfigurationPicker(props: {
  readonly slot: ConfigurationSlot
  readonly configuration: ConfigurationDraft
  readonly disabled: boolean
  readonly onChange: (configuration: ConfigurationDraft) => void
}): JSX.Element {
  const t = useTranslator(tasksDictionary)
  const current = () =>
    CLOUD_HARNESSES.find(
      (harness) => harness.id === props.configuration.harness?.id && harness.access === props.configuration.harness.access,
    )
  onMount(() => {
    const harness = props.configuration.harness
    if (harness && !props.configuration.model && cloudPresetModel(harness)) props.onChange(cloudConfiguration(harness))
  })
  return (
    <div class="tsk-stack" data-testid={`preset-configuration-${props.slot}`}>
      <Select
        options={[...CLOUD_HARNESSES]}
        current={current()}
        value={(harness: HarnessReference) => harness.id}
        label={(harness: HarnessReference) => harnessDisplayLabel(harness.id)}
        placeholder={t("tasks.preset.harnessPlaceholder")}
        disabled={props.disabled}
        triggerProps={{ "data-testid": `preset-cloud-harness-${props.slot}`, "aria-label": t("tasks.preset.harness") }}
        onSelect={(harness) => {
          if (harness && harness.id !== props.configuration.harness?.id) props.onChange(cloudConfiguration(harness))
        }}
      />
      <CloudModelNote configuration={props.configuration} slot={props.slot} />
    </div>
  )
}
