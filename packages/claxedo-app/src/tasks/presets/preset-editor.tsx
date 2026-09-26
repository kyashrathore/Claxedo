import { For, Show, createSignal, untrack, type JSX } from "solid-js"
import {
  CONFIGURATION_SLOTS,
  PRESET_PLACEMENTS,
  TASKS_BOUNDS,
  type ConfigurationSlot,
  type PresetPlacement,
} from "@claxedo/tasks"
import { useTranslator } from "@/i18n"
import { Button, Checkbox, Switch, TextField } from "@/ui"
import { fieldReasonKey, type FieldReasons } from "../data/refusal"
import { tasksDictionary } from "../i18n"
import { SLOT_KEYS } from "../model"
import { ProseField } from "../view/prose-field"
import type { CapabilityCatalog } from "./capabilities"
import { CapabilityNotice, CapabilityPicker } from "./capability-picker"
import { ConfigurationEditor } from "./configuration-editor"
import {
  EMPTY_CONFIGURATION,
  parsePresetEditorDraft,
  rebaseConfiguration,
  type ConfigurationDraft,
  type FieldProblem,
  type PresetEditorDraft,
} from "./draft"

const OPTIONAL_SLOTS = CONFIGURATION_SLOTS.filter(
  (slot): slot is Exclude<ConfigurationSlot, "primary"> => slot !== "primary",
)

export type PresetEditorProps = {
  readonly draft: PresetEditorDraft
  readonly onDraftChange: (draft: PresetEditorDraft) => void
  readonly placements: readonly PresetPlacement[]
  readonly catalog: () => CapabilityCatalog
  readonly busy?: boolean
  readonly error?: string
  readonly fieldErrors?: FieldReasons
  readonly submitLabel: string
  readonly onSubmit: (draft: PresetEditorDraft) => void
  readonly onCancel: () => void
}

type FieldText = (path: string) => string | undefined

function PlacementField(
  props: PresetEditorProps & { readonly patch: (input: Partial<PresetEditorDraft>) => void },
): JSX.Element {
  const t = useTranslator(tasksDictionary)
  const label = (placement: PresetPlacement) => t(placement === "cloud" ? "tasks.preset.cloud" : "tasks.preset.local")
  return (
    <fieldset class="tsk-field" data-testid="preset-editor-placement">
      <legend class="tsk-label">{t("tasks.preset.execution")}</legend>
      <div class="tsk-capability-list">
        <For each={PRESET_PLACEMENTS}>
          {(placement) => (
            <label class="tsk-pick">
              <input
                type="radio"
                name="preset-placement"
                data-testid={`preset-editor-placement-${placement}`}
                checked={props.draft.placement === placement}
                disabled={!props.placements.includes(placement)}
                onChange={() => props.patch({ placement })}
              />
              <span>{label(placement)}</span>
            </label>
          )}
        </For>
      </div>
      <Show when={!props.placements.includes(props.draft.placement)}>
        <p class="tsk-error" data-testid="preset-editor-placement-unsupported">
          {t("tasks.preset.unsupportedPlacement", { placement: label(props.draft.placement) })}
        </p>
      </Show>
    </fieldset>
  )
}

function SlotEditor(props: {
  readonly slot: ConfigurationSlot
  readonly draft: PresetEditorDraft
  readonly busy?: boolean
  readonly fieldText: FieldText
  readonly onChange: (value: ConfigurationDraft) => void
}): JSX.Element {
  const entry = () => props.draft.configurations[props.slot] ?? EMPTY_CONFIGURATION
  return (
    <div class="tsk-stack" data-testid={`preset-editor-configuration-${props.slot}`}>
      <ConfigurationEditor
        slot={props.slot}
        configuration={entry()}
        disabled={props.busy === true}
        onChange={(next) => untrack(() => props.onChange(rebaseConfiguration(entry(), next)))}
      />
      <For each={["model", "harness", "effort"] as const}>
        {(field) => (
          <Show when={props.fieldText(`configurations.${props.slot}.${field}`)}>
            {(message) => (
              <span class="tsk-error" data-testid={`preset-editor-error-${props.slot}-${field}`}>
                {message()}
              </span>
            )}
          </Show>
        )}
      </For>
    </div>
  )
}

function Configurations(props: PresetEditorProps & { readonly fieldText: FieldText }): JSX.Element {
  const t = useTranslator(tasksDictionary)
  const setConfiguration = (slot: ConfigurationSlot, value: ConfigurationDraft | null) =>
    props.onDraftChange({ ...props.draft, configurations: { ...props.draft.configurations, [slot]: value } })
  return (
    <section class="tsk-stack" aria-label={t("tasks.preset.configurations")}>
      <h2 class="tsk-section-title">{t("tasks.preset.primaryConfiguration")}</h2>
      <SlotEditor
        slot="primary"
        draft={props.draft}
        busy={props.busy}
        fieldText={props.fieldText}
        onChange={(value) => setConfiguration("primary", value)}
      />
      <h2 class="tsk-section-title">{t("tasks.preset.additionalConfigurations")}</h2>
      <p class="tsk-hint">{t("tasks.preset.labelsHint")}</p>
      <div class="tsk-capability-list">
        <For each={OPTIONAL_SLOTS}>
          {(slot) => (
            <Checkbox
              class="tsk-pick"
              data-testid={`preset-editor-slot-${slot}`}
              checked={props.draft.configurations[slot] !== null}
              onChange={(checked: boolean) => setConfiguration(slot, checked ? EMPTY_CONFIGURATION : null)}
              label={t(SLOT_KEYS[slot])}
            />
          )}
        </For>
      </div>
      <For each={OPTIONAL_SLOTS}>
        {(slot) => (
          <Show when={props.draft.configurations[slot] !== null}>
            <div class="tsk-stack">
              <h3 class="tsk-label">{t(SLOT_KEYS[slot])}</h3>
              <SlotEditor
                slot={slot}
                draft={props.draft}
                busy={props.busy}
                fieldText={props.fieldText}
                onChange={(value) => setConfiguration(slot, value)}
              />
            </div>
          </Show>
        )}
      </For>
    </section>
  )
}

function createFieldText(props: PresetEditorProps, attempted: () => boolean): FieldText {
  const t = useTranslator(tasksDictionary)
  const local = () => {
    if (!attempted()) return undefined
    const parsed = parsePresetEditorDraft(props.draft)
    return parsed.ok ? undefined : parsed.fields
  }
  const say = (problem: FieldProblem) => t(problem.key, problem.params)
  return (path) => {
    const server = props.fieldErrors?.[path]
    if (server) return t(fieldReasonKey(server))
    const problem = local()?.[path]
    return problem ? say(problem) : undefined
  }
}

function IdentityFields(
  props: PresetEditorProps & {
    readonly fieldText: FieldText
    readonly patch: (input: Partial<PresetEditorDraft>) => void
  },
): JSX.Element {
  const t = useTranslator(tasksDictionary)
  return (
    <>
      <div class="tsk-field">
        <span class="tsk-label">{t("tasks.preset.name")}</span>
        <TextField
          data-testid="preset-editor-name"
          aria-label={t("tasks.preset.name")}
          placeholder={t("tasks.preset.namePlaceholder")}
          maxLength={TASKS_BOUNDS.presetNameMax}
          validationState={props.fieldText("name") ? "invalid" : "valid"}
          value={props.draft.name}
          onChange={(name: string) => props.patch({ name })}
        />
        <Show when={props.fieldText("name")}>{(message) => <span class="tsk-error">{message()}</span>}</Show>
      </div>
      <PlacementField {...props} />
      <div class="tsk-field" data-testid="preset-editor-agent-startable">
        <Switch
          checked={props.draft.agentStartable}
          onChange={(agentStartable: boolean) => props.patch({ agentStartable })}
        >
          {t("tasks.preset.agentStartable")}
        </Switch>
        <p class="tsk-hint">{t("tasks.preset.agentStartableHint")}</p>
      </div>
    </>
  )
}

export function PresetEditor(props: PresetEditorProps): JSX.Element {
  const t = useTranslator(tasksDictionary)
  const patch = (input: Partial<PresetEditorDraft>) => props.onDraftChange({ ...props.draft, ...input })
  const [attempted, setAttempted] = createSignal(false)
  const fieldText = createFieldText(props, attempted)
  const submit = () => {
    setAttempted(true)
    if (parsePresetEditorDraft(props.draft).ok) props.onSubmit(props.draft)
  }
  return (
    <form
      class="tsk tsk-stack"
      data-testid="preset-editor"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <div class="tsk-page-head">
        <span class="tsk-spacer" />
        <Button size="small" variant="ghost" data-testid="preset-editor-cancel" onClick={() => props.onCancel()}>
          {t("tasks.cancel")}
        </Button>
        <Button type="submit" size="small" variant="primary" data-testid="preset-editor-submit" disabled={props.busy}>
          {props.submitLabel}
        </Button>
      </div>
      <div class="tsk-stack tsk-preset-form">
        <IdentityFields {...props} fieldText={fieldText} patch={patch} />
        <div class="tsk-divider" />
        <Configurations {...props} fieldText={fieldText} />
        <div class="tsk-divider" />
        <div class="tsk-field">
          <span class="tsk-label">{t("tasks.preset.instructions")}</span>
          <div class="tsk-prose tsk-prose-boxed">
            <ProseField
              value={props.draft.instructions}
              placeholder={t("tasks.preset.instructionsPlaceholder")}
              ariaLabel={t("tasks.preset.instructionsLabel")}
              testId="preset-editor-instructions"
              onChange={(instructions) => patch({ instructions })}
            />
          </div>
          <Show when={fieldText("instructions")}>{(message) => <span class="tsk-error">{message()}</span>}</Show>
        </div>
        <section class="tsk-stack" aria-label={t("tasks.preset.capabilities")}>
          <h2 class="tsk-section-title">{t("tasks.preset.capabilities")}</h2>
          <CapabilityNotice placement={props.draft.placement} testId="preset-editor-capability-guarantee" />
          <Show when={props.draft.placement === "cloud"}>
            <CapabilityPicker draft={props.draft} catalog={props.catalog} onDraftChange={props.onDraftChange} />
          </Show>
        </section>
      </div>
      <Show when={props.error}>
        {(message) => (
          <p class="tsk-error" role="alert">
            {message()}
          </p>
        )}
      </Show>
    </form>
  )
}
