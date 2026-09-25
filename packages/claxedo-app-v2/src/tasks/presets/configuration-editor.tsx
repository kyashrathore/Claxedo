import { Show, type JSX } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import type { ConfigurationSlot, HarnessReference } from "@claxedo/tasks"
import { DraftHarnessPicker, type DraftHarnessChoice } from "@/composer"
import { useTranslator } from "@/i18n"
import { NATIVE_HARNESS_IDS, connectionHarness, nativeHarness, type HarnessSelection } from "@/lib/harness-selection"
import { useServer } from "@/server"
import { tasksDictionary } from "../i18n"
import type { ConfigurationDraft } from "./draft"
import { Select } from "@/ui"

function harnessReferenceOf(selection: HarnessSelection): HarnessReference {
  return selection.kind === "native"
    ? { id: selection.harnessId, access: "native" }
    : { id: selection.connectionId, access: "connection" }
}

function harnessSelectionOf(reference: HarnessReference): HarnessSelection | undefined {
  if (reference.access === "connection") return connectionHarness(reference.id)
  const native = NATIVE_HARNESS_IDS.find((id) => id === reference.id)
  return native ? nativeHarness(native) : undefined
}

function choiceOf(configuration: ConfigurationDraft): DraftHarnessChoice {
  return {
    harness: configuration.harness ? harnessSelectionOf(configuration.harness) : undefined,
    model: configuration.model ? { providerId: configuration.model.providerID, modelId: configuration.model.modelID } : undefined,
    effort: configuration.effort ?? undefined,
  }
}

function configurationOf(choice: DraftHarnessChoice): ConfigurationDraft {
  return {
    harness: choice.harness ? harnessReferenceOf(choice.harness) : null,
    model: choice.model ? { providerID: choice.model.providerId, modelID: choice.model.modelId } : null,
    effort: choice.effort ?? null,
  }
}

export function ConfigurationEditor(props: {
  readonly slot: ConfigurationSlot
  readonly configuration: ConfigurationDraft
  readonly disabled: boolean
  readonly onChange: (configuration: ConfigurationDraft) => void
}): JSX.Element {
  const t = useTranslator(tasksDictionary)
  const server = useServer()
  const placements = useQuery(() => server.queries.placements.list())
  const placement = () => placements.data?.[0]?.id
  return (
    <Show
      when={placement()}
      fallback={
        <p class="tsk-hint" data-testid={`preset-configuration-catalog-${props.slot}`}>
          {placements.isPending ? t("tasks.preset.loadingProjects") : t("tasks.preset.addProjectFirst")}
        </p>
      }
    >
      {(placementId) => (
        <div data-testid={`preset-configuration-${props.slot}`}>
          <DraftHarnessPicker
            placementId={placementId()}
            seed={choiceOf(props.configuration)}
            active={!props.disabled}
            onChange={(choice) => props.onChange(configurationOf(choice))}
          />
        </div>
      )}
    </Show>
  )
}
