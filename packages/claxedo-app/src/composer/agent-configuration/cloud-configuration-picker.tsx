import { Show, onMount, type JSX } from "solid-js"
import { harnessDisplayLabel } from "@/lib/harness-catalog"
import { NATIVE_HARNESS_IDS, isCatalogHarnessId } from "@/lib/harness-selection"
import { Select } from "@/ui"
import { useAgentConfigurationText } from "./i18n"
import { CloudCatalogModelPicker } from "./cloud-catalog-model-picker"
import { cloudConfiguration, cloudDefaultModel, isCloudDefaultModel } from "./cloud-model"
import type { AgentConfiguration, AgentHarnessReference } from "./model"

const CLOUD_HARNESSES: readonly AgentHarnessReference[] = NATIVE_HARNESS_IDS.map((id) => ({ id, access: "native" }))

function CloudModelNote(props: { readonly configuration: AgentConfiguration }): JSX.Element {
  const t = useAgentConfigurationText()
  const harness = () => harnessDisplayLabel(props.configuration.harness?.id ?? "")
  return (
    <Show when={props.configuration.model}>
      {(model) => (
        <p class="text-12-regular text-text-weak">
          {isCloudDefaultModel(props.configuration)
            ? t("agentConfiguration.cloudDefaultModel", { harness: harness() })
            : t("agentConfiguration.cloudSavedModel", { model: model().modelID })}
        </p>
      )}
    </Show>
  )
}

export function CloudConfigurationPicker(props: {
  readonly configuration: AgentConfiguration
  readonly disabled: boolean
  readonly onChange: (configuration: AgentConfiguration) => void
}): JSX.Element {
  const t = useAgentConfigurationText()
  const current = () =>
    CLOUD_HARNESSES.find((harness) => harness.id === props.configuration.harness?.id && harness.access === props.configuration.harness.access)
  const catalogHarness = () => {
    const harness = props.configuration.harness
    return harness?.access === "native" && isCatalogHarnessId(harness.id) ? harness : undefined
  }
  onMount(() => {
    const harness = props.configuration.harness
    if (harness && !props.configuration.model && cloudDefaultModel(harness)) props.onChange(cloudConfiguration(harness))
  })
  return (
    <div class="flex flex-col gap-2 min-w-0">
      <Select
        options={[...CLOUD_HARNESSES]}
        current={current()}
        value={(harness: AgentHarnessReference) => harness.id}
        label={(harness: AgentHarnessReference) => harnessDisplayLabel(harness.id)}
        placeholder={t("agentConfiguration.harnessPlaceholder")}
        disabled={props.disabled}
        triggerProps={{ "aria-label": t("agentConfiguration.harness") }}
        onSelect={(harness) => {
          if (harness && harness.id !== props.configuration.harness?.id) props.onChange(cloudConfiguration(harness))
        }}
      />
      <Show when={catalogHarness()} fallback={<CloudModelNote configuration={props.configuration} />}>
        {(harness) => (
          <CloudCatalogModelPicker
            harness={harness()}
            model={props.configuration.model}
            disabled={props.disabled}
            onModel={(model) => props.onChange({ harness: harness(), model, effort: null })}
          />
        )}
      </Show>
    </div>
  )
}
