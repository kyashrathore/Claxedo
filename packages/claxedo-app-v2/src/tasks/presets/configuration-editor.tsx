import { Show, createEffect, createMemo, onMount, type Accessor, type JSX } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import type { ConfigurationSlot, HarnessReference } from "@claxedo/tasks"
import { createHarnessConnectionsCatalog } from "@/composer"
import { useTranslator } from "@/i18n"
import { placementId, useServer, type HarnessModel, type ModelChoice } from "@/server"
import { dictionary } from "../i18n"
import type { ConfigurationDraft } from "./draft"
import { Select } from "@/ui"

type HarnessChoice = { readonly ref: HarnessReference; readonly label: string; readonly available: boolean }

function useHarnessChoices(): Accessor<readonly HarnessChoice[]> {
  const server = useServer()
  const connections = createHarnessConnectionsCatalog({ api: server.harnessConfig })
  onMount(() => void connections.refresh())
  return createMemo(() => {
    const native = (server.capabilities()?.harnesses ?? []).map((harness) => ({
      ref: { id: harness.id, access: "native" as const },
      label: harness.name,
      available: harness.available,
    }))
    const catalog = connections.data()
    const connected =
      catalog?.status === "supported"
        ? catalog.connections
            .filter((connection) => connection.enabled)
            .map((connection) => ({
              ref: { id: connection.connectionId, access: "connection" as const },
              label: connection.label,
              available: connection.readiness !== "unavailable",
            }))
        : []
    return [...native, ...connected]
  })
}

function seedDefaults(
  props: { readonly configuration: ConfigurationDraft; readonly onChange: (configuration: ConfigurationDraft) => void },
  harnesses: Accessor<readonly HarnessChoice[]>,
  current: Accessor<ModelChoice | undefined>,
) {
  createEffect(() => {
    if (props.configuration.harness) return
    const first = harnesses().find((entry) => entry.available)
    if (first) props.onChange({ harness: first.ref, model: null, effort: null })
  })
  createEffect(() => {
    const model = current()
    if (!props.configuration.harness || props.configuration.model || !model) return
    props.onChange({
      ...props.configuration,
      model: { providerID: model.providerId, modelID: model.modelId },
      effort: model.variant ?? null,
    })
  })
}

function sameRef(left: HarnessReference | null, right: HarnessReference) {
  return left?.id === right.id && left.access === right.access
}

export function ConfigurationEditor(props: {
  readonly slot: ConfigurationSlot
  readonly configuration: ConfigurationDraft
  readonly disabled: boolean
  readonly onChange: (configuration: ConfigurationDraft) => void
}): JSX.Element {
  const t = useTranslator(dictionary)
  const server = useServer()
  const harnesses = useHarnessChoices()
  const placements = useQuery(() => server.queries.placements.list())
  const placement = () => placements.data?.[0]?.id
  const options = useQuery(() => {
    const harness = props.configuration.harness?.id ?? ""
    return {
      ...server.queries.harnesses.options(placement() ?? placementId(""), harness),
      enabled: !!placement() && harness.length > 0,
    }
  })
  const models = () => options.data?.models ?? []
  const currentModel = () =>
    models().find(
      (entry) =>
        entry.model.providerId === props.configuration.model?.providerID &&
        entry.model.modelId === props.configuration.model?.modelID,
    )
  const efforts = () => currentModel()?.efforts ?? options.data?.efforts ?? []
  seedDefaults(props, harnesses, () => options.data?.current)
  return (
    <Show
      when={placement() || placements.isPending}
      fallback={
        <p class="tsk-hint" data-testid={`preset-configuration-catalog-${props.slot}`}>
          {t("tasks.preset.addProjectFirst")}
        </p>
      }
    >
      <div class="tsk-chiprow" data-testid={`preset-configuration-${props.slot}`}>
        <Select
          size="small"
          options={[...harnesses()]}
          current={harnesses().find((entry) => sameRef(props.configuration.harness, entry.ref))}
          value={(entry: HarnessChoice) => `${entry.ref.access}:${entry.ref.id}`}
          label={(entry: HarnessChoice) => entry.label}
          placeholder={t("tasks.preset.harness")}
          disabled={props.disabled}
          triggerProps={{ "data-testid": `preset-harness-${props.slot}`, "aria-label": t("tasks.preset.harness") }}
          onSelect={(entry) => {
            if (entry) props.onChange({ harness: entry.ref, model: null, effort: null })
          }}
        />
        <Select
          size="small"
          options={[...models()]}
          current={currentModel()}
          value={(entry: HarnessModel) => `${entry.model.providerId}/${entry.model.modelId}`}
          label={(entry: HarnessModel) => entry.name}
          placeholder={t("tasks.preset.model")}
          disabled={props.disabled || !props.configuration.harness}
          triggerProps={{ "data-testid": `preset-model-${props.slot}`, "aria-label": t("tasks.preset.model") }}
          onSelect={(entry) => {
            if (!entry) return
            const model = { providerID: entry.model.providerId, modelID: entry.model.modelId }
            props.onChange({ ...props.configuration, model, effort: null })
          }}
        />
        <Show when={efforts().length > 0}>
          <Select
            size="small"
            options={[...efforts()]}
            current={props.configuration.effort ?? undefined}
            value={(effort: string) => effort}
            label={(effort: string) => effort}
            placeholder={t("tasks.preset.effort")}
            disabled={props.disabled || !props.configuration.model}
            triggerProps={{ "data-testid": `preset-effort-${props.slot}`, "aria-label": t("tasks.preset.effort") }}
            onSelect={(effort) => props.onChange({ ...props.configuration, effort: effort ?? null })}
          />
        </Show>
      </div>
    </Show>
  )
}
