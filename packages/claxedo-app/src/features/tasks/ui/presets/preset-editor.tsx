import { For, Show, createSignal, untrack } from "solid-js"
import { Dynamic } from "solid-js/web"
import { Button } from "@opencode-ai/ui/button"
import { Checkbox } from "@opencode-ai/ui/checkbox"
import { TextField } from "@opencode-ai/ui/text-field"
import {
  CONFIGURATION_SLOTS,
  PRESET_PLACEMENTS,
  TASKS_BOUNDS,
  type ConfigurationSlot,
  type PresetPlacement,
} from "@claxedo/tasks"
import {
  EMPTY_CONFIGURATION,
  parsePresetEditorDraft,
  isCapabilitySelected,
  toggleCapability,
  rebaseConfiguration,
  type CapabilitySelection,
  type ConfigurationDraft,
  type ConfigurationEditor,
  type PresetEditorDraft,
} from "../../preset-editor-model"
import { CapabilityNotice } from "../shared/capability-notice"
import type { ProseEditor } from "../../app-ports"
import {
  PLACEMENT_LABELS,
  SLOT_LABELS,
  type CapabilityCatalogReader,
  type CapabilityOption,
  type FieldErrors,
} from "../../view-model"

const OPTIONAL_SLOTS = CONFIGURATION_SLOTS.filter((slot): slot is Exclude<ConfigurationSlot, "primary"> => slot !== "primary")

export type PresetEditorProps = {
  /** The preset being edited, or "new"; the configuration editor scopes its selectors by it. */
  editorKey: string
  draft: PresetEditorDraft
  onDraftChange: (draft: PresetEditorDraft) => void
  /** Placements this host can actually run; an unsupported one is refused, never swapped. */
  placements: readonly PresetPlacement[]
  catalog: CapabilityCatalogReader
  configurationEditor: ConfigurationEditor
  /** The host's markdown editor; instructions are prose, not a text field. */
  proseEditor: ProseEditor
  busy?: boolean
  error?: string
  /** Field errors the server named, merged with the ones submit finds locally. */
  fieldErrors?: FieldErrors
  submitLabel: string
  onSubmit: (draft: PresetEditorDraft) => void
  onCancel: () => void
}

export function PresetEditor(props: PresetEditorProps) {
  const patch = (input: Partial<PresetEditorDraft>) => props.onDraftChange({ ...props.draft, ...input })
  const setConfiguration = (slot: ConfigurationSlot, value: ConfigurationDraft | null) =>
    patch({ configurations: { ...props.draft.configurations, [slot]: value } })
  const [attempted, setAttempted] = createSignal(false)
  const localFields = () => {
    if (!attempted()) return undefined
    const parsed = parsePresetEditorDraft(props.draft)
    return parsed.ok ? undefined : parsed.fields
  }
  const fieldError = (path: string) => props.fieldErrors?.[path] ?? localFields()?.[path]
  const isCloud = () => props.draft.placement === "cloud"

  const submit = () => {
    setAttempted(true)
    const parsed = parsePresetEditorDraft(props.draft)
    if (!parsed.ok) return
    props.onSubmit(props.draft)
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
          Cancel
        </Button>
        <Button type="submit" size="small" variant="primary" data-testid="preset-editor-submit" disabled={props.busy}>
          {props.submitLabel}
        </Button>
      </div>

      <div class="tsk-stack tsk-preset-form">
        <div class="tsk-field">
          <span class="tsk-label">Name</span>
          <TextField
            data-testid="preset-editor-name"
            aria-label="Name"
            placeholder="Careful reviewer"
            maxLength={TASKS_BOUNDS.presetNameMax}
            validationState={fieldError("name") ? "invalid" : "valid"}
            value={props.draft.name}
            onChange={(name: string) => patch({ name })}
          />
          <Show when={fieldError("name")}>{(message) => <span class="tsk-error">{message()}</span>}</Show>
        </div>

        <fieldset class="tsk-field" data-testid="preset-editor-placement">
          <legend class="tsk-label">Execution</legend>
          {/* Native radios: the host's RadioGroup is a segmented control with no
              per-option disabled, and a placement this server cannot run must
              not be selectable. */}
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
                    onChange={() => patch({ placement })}
                  />
                  <span>{PLACEMENT_LABELS[placement]}</span>
                </label>
              )}
            </For>
          </div>
          <Show when={!props.placements.includes(props.draft.placement)}>
            <p class="tsk-error" data-testid="preset-editor-placement-unsupported">
              This server cannot run {PLACEMENT_LABELS[props.draft.placement]} presets. Saving keeps the choice; starting
              will be refused rather than moved elsewhere.
            </p>
          </Show>
        </fieldset>

        <div class="tsk-divider" />

        <section class="tsk-stack" aria-label="Configurations">
          <h3 class="tsk-section-title">Primary configuration</h3>
          <SlotEditor
            editorKey={props.editorKey}
            slot="primary"
            draft={props.draft}
            editor={props.configurationEditor}
            busy={props.busy}
            fieldError={fieldError}
            onChange={(value) => setConfiguration("primary", value)}
          />

          <h3 class="tsk-section-title">Additional configurations</h3>
          <p class="tsk-hint">
            Labels describe intended use. They are settings you pick when starting a session, not stages that run on
            their own.
          </p>
          <div class="tsk-capability-list">
            <For each={OPTIONAL_SLOTS}>
              {(slot) => (
                <Checkbox
                  class="tsk-pick"
                  data-testid={`preset-editor-slot-${slot}`}
                  checked={props.draft.configurations[slot] !== null}
                  onChange={(checked: boolean) => setConfiguration(slot, checked ? EMPTY_CONFIGURATION : null)}
                >
                  {SLOT_LABELS[slot]}
                </Checkbox>
              )}
            </For>
          </div>
          <For each={OPTIONAL_SLOTS}>
            {(slot) => (
              <Show when={props.draft.configurations[slot] !== null}>
                <div class="tsk-stack">
                  <h4 class="tsk-label">{SLOT_LABELS[slot]}</h4>
                  <SlotEditor
                    editorKey={props.editorKey}
                    slot={slot}
                    draft={props.draft}
                    editor={props.configurationEditor}
                    busy={props.busy}
                    fieldError={fieldError}
                    onChange={(value) => setConfiguration(slot, value)}
                  />
                </div>
              </Show>
            )}
          </For>
        </section>

        <div class="tsk-divider" />

        <div class="tsk-field">
          <span class="tsk-label">Instructions</span>
          <div class="tsk-prose tsk-prose-boxed">
            <Dynamic
              component={props.proseEditor}
              value={props.draft.instructions}
              placeholder="What this agent should always do, whatever the task says"
              ariaLabel="Preset instructions"
              testId="preset-editor-instructions"
              onChange={(instructions) => patch({ instructions })}
            />
          </div>
          <Show when={fieldError("instructions")}>{(message) => <span class="tsk-error">{message()}</span>}</Show>
        </div>

        <section class="tsk-stack" aria-label="Capabilities">
          <h3 class="tsk-section-title">Capabilities</h3>
          <CapabilityNotice placement={props.draft.placement} testId="preset-editor-capability-guarantee" />
          <Show when={isCloud()}>
            <CapabilityPicker draft={props.draft} catalog={props.catalog} onDraftChange={props.onDraftChange} />
          </Show>
        </section>
      </div>

      <Show when={props.error}>{(message) => <p class="tsk-error" role="alert">{message()}</p>}</Show>

    </form>
  )
}


function SlotEditor(props: {
  editorKey: string
  slot: ConfigurationSlot
  draft: PresetEditorDraft
  editor: ConfigurationEditor
  busy?: boolean
  fieldError: (path: string) => string | undefined
  onChange: (value: ConfigurationDraft) => void
}) {
  const entry = () => props.draft.configurations[props.slot] ?? EMPTY_CONFIGURATION
  return (
    <div class="tsk-stack" data-testid={`preset-editor-configuration-${props.slot}`}>
      <Dynamic
        component={props.editor}
        editorKey={props.editorKey}
        slot={props.slot}
        configuration={entry()}
        disabled={props.busy === true}
        placement={props.draft.placement}
        onChange={(next) => untrack(() => props.onChange(rebaseConfiguration(entry(), next)))}
      />
      <Show when={props.fieldError(`configurations.${props.slot}.model`)}>
        {(message) => (
          <span class="tsk-error" data-testid={`preset-editor-error-${props.slot}-model`}>
            {message()}
          </span>
        )}
      </Show>
      <Show when={props.fieldError(`configurations.${props.slot}.harness`)}>
        {(message) => (
          <span class="tsk-error" data-testid={`preset-editor-error-${props.slot}-harness`}>
            {message()}
          </span>
        )}
      </Show>
      <Show when={props.fieldError(`configurations.${props.slot}.effort`)}>
        {(message) => (
          <span class="tsk-error" data-testid={`preset-editor-error-${props.slot}-effort`}>
            {message()}
          </span>
        )}
      </Show>
    </div>
  )
}

function CapabilityPicker(props: {
  draft: PresetEditorDraft
  catalog: CapabilityCatalogReader
  onDraftChange: (draft: PresetEditorDraft) => void
}) {
  const catalog = () => props.catalog()

  return (
    <div class="tsk-stack" data-testid="preset-editor-cloud-capabilities">
      <p class="tsk-hint">
        An empty selection means none of these optional capabilities. The platform tools every session needs are always
        present.
      </p>
      <Show when={catalog().error}>{(message) => <p class="tsk-error">{message()}</p>}</Show>
      <Show when={catalog().loading}>
        <p class="tsk-hint">Loading installed capabilities…</p>
      </Show>

      <CapabilityGroup
        label="Plugins"
        kind="plugin"
        options={catalog().plugins}
        empty="No installed plugins."
        selected={props.draft.plugins}
        onToggle={(capability) =>
          props.onDraftChange({ ...props.draft, plugins: toggleCapability(props.draft.plugins, capability) })
        }
      />
      <CapabilityGroup
        label="Skills"
        kind="skill"
        options={catalog().skills}
        empty="No installed skills."
        selected={props.draft.skills}
        onToggle={(capability) =>
          props.onDraftChange({ ...props.draft, skills: toggleCapability(props.draft.skills, capability) })
        }
      />
      <p class="tsk-hint">A selected skill adds guidance only. It does not enable the plugin that supplies it.</p>
    </div>
  )
}

/**
 * One kind of capability as a list of checkboxes.
 *
 * A revoked capability the preset still names stays checked and enabled, so the
 * only way to lose it is to clear it here; one that was never selected cannot be
 * added while it is unavailable.
 */
function CapabilityGroup(props: {
  label: string
  /** Names this group's test ids, so a checkbox is addressable by what it selects. */
  kind: "plugin" | "skill"
  options: readonly CapabilityOption[]
  empty: string
  selected: readonly CapabilitySelection[]
  onToggle: (capability: CapabilitySelection) => void
}) {
  const chosen = (option: CapabilityOption) =>
    isCapabilitySelected(props.selected, { sourceId: option.sourceId, name: option.name })

  return (
    <>
      <span class="tsk-label">{props.label}</span>
      <div class="tsk-capability-list" data-testid={`preset-editor-${props.kind}s`}>
        <For each={props.options} fallback={<span class="tsk-hint">{props.empty}</span>}>
          {(option) => (
            <Checkbox
              class="tsk-pick"
              data-testid={`preset-editor-${props.kind}-${option.key}`}
              description={option.bundledSkills?.length ? `Bundled skills: ${option.bundledSkills.join(", ")}` : option.description}
              checked={chosen(option)}
              disabled={!option.available && !chosen(option)}
              onChange={() => props.onToggle({ sourceId: option.sourceId, name: option.name })}
            >
              {option.label}
              <Show when={!option.available}>
                <span class="tsk-error"> {option.unavailableReason ?? "Unavailable"}</span>
              </Show>
            </Checkbox>
          )}
        </For>
      </div>
    </>
  )
}
