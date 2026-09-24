import { For, Show, type JSX } from "solid-js"
import type { PresetPlacement } from "@claxedo/tasks"
import { useTranslator } from "@/i18n"
import { Checkbox, Icon } from "@/ui"
import { dictionary } from "../i18n"
import type { CapabilityCatalog, CapabilityOption } from "./capabilities"
import { isCapabilitySelected, toggleCapability, type CapabilitySelection, type PresetEditorDraft } from "./draft"

export function CapabilityNotice(props: {
  readonly placement: PresetPlacement
  readonly testId?: string
}): JSX.Element {
  const t = useTranslator(dictionary)
  return (
    <p class="tsk-notice-inline" data-testid={props.testId}>
      <Icon name="circle-alert" size="small" class="tsk-notice-glyph" />
      <span>{t(props.placement === "cloud" ? "tasks.preset.guaranteeCloud" : "tasks.preset.guaranteeLocal")}</span>
    </p>
  )
}

function CapabilityGroup(props: {
  readonly label: string
  readonly kind: "plugin" | "skill"
  readonly options: readonly CapabilityOption[]
  readonly empty: string
  readonly selected: readonly CapabilitySelection[]
  readonly onToggle: (capability: CapabilitySelection) => void
}): JSX.Element {
  const t = useTranslator(dictionary)
  const chosen = (option: CapabilityOption) =>
    isCapabilitySelected(props.selected, { sourceId: option.sourceId, name: option.name })
  const reason = (option: CapabilityOption) =>
    option.unavailable ? ("key" in option.unavailable ? t(option.unavailable.key) : option.unavailable.text) : undefined
  const description = (option: CapabilityOption) =>
    option.bundledSkills?.length
      ? t("tasks.preset.bundledSkills", { skills: option.bundledSkills.join(", ") })
      : option.description
  return (
    <>
      <span class="tsk-label">{props.label}</span>
      <div class="tsk-capability-list" data-testid={`preset-editor-${props.kind}s`}>
        <For each={props.options} fallback={<span class="tsk-hint">{props.empty}</span>}>
          {(option) => (
            <Checkbox
              class="tsk-pick"
              data-testid={`preset-editor-${props.kind}-${option.key}`}
              description={description(option)}
              checked={chosen(option)}
              disabled={option.unavailable !== undefined && !chosen(option)}
              onChange={() => props.onToggle({ sourceId: option.sourceId, name: option.name })}
            >
              {option.name}
              <Show when={reason(option)}>{(text) => <span class="tsk-error"> {text()}</span>}</Show>
            </Checkbox>
          )}
        </For>
      </div>
    </>
  )
}

export function CapabilityPicker(props: {
  readonly draft: PresetEditorDraft
  readonly catalog: () => CapabilityCatalog
  readonly onDraftChange: (draft: PresetEditorDraft) => void
}): JSX.Element {
  const t = useTranslator(dictionary)
  const catalog = () => props.catalog()
  return (
    <div class="tsk-stack" data-testid="preset-editor-cloud-capabilities">
      <p class="tsk-hint">{t("tasks.preset.emptySelection")}</p>
      <Show when={catalog().error}>{(message) => <p class="tsk-error">{message()}</p>}</Show>
      <Show when={catalog().loading}>
        <p class="tsk-hint">{t("tasks.preset.loadingCapabilities")}</p>
      </Show>
      <CapabilityGroup
        label={t("tasks.preset.plugins")}
        kind="plugin"
        options={catalog().plugins}
        empty={t("tasks.preset.noPlugins")}
        selected={props.draft.plugins}
        onToggle={(capability) =>
          props.onDraftChange({ ...props.draft, plugins: toggleCapability(props.draft.plugins, capability) })
        }
      />
      <CapabilityGroup
        label={t("tasks.preset.skills")}
        kind="skill"
        options={catalog().skills}
        empty={t("tasks.preset.noSkills")}
        selected={props.draft.skills}
        onToggle={(capability) =>
          props.onDraftChange({ ...props.draft, skills: toggleCapability(props.draft.skills, capability) })
        }
      />
      <p class="tsk-hint">{t("tasks.preset.skillGuidance")}</p>
    </div>
  )
}
