import { For, Show, createSignal, untrack } from "solid-js"
import { Dynamic } from "solid-js/web"
import {
  CONFIGURATION_SLOTS,
  PRESET_PLACEMENTS,
  TASKS_BOUNDS,
  type ConfigurationSlot,
  type PresetPlacement,
} from "../contracts"
import {
  EMPTY_CONFIGURATION,
  parsePresetEditorDraft,
  togglePluginReference,
  toggleSkillReference,
  rebaseConfiguration,
  type ConfigurationDraft,
  type ConfigurationEditor,
  type PresetEditorDraft,
} from "./preset-editor-model"
import {
  LOCAL_CAPABILITY_TEXT,
  PLACEMENT_LABELS,
  SLOT_LABELS,
  type CapabilityCatalogReader,
  type FieldErrors,
} from "./view-model"

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
      <div class="tsk-form-split">
        <div class="tsk-stack">
          <label class="tsk-field">
            <span class="tsk-label">Name</span>
            <input
              class="tsk-input"
              data-testid="preset-editor-name"
              placeholder="Careful reviewer"
              maxLength={TASKS_BOUNDS.presetNameMax}
              aria-invalid={fieldError("name") ? "true" : undefined}
              value={props.draft.name}
              onInput={(event) => patch({ name: event.currentTarget.value })}
            />
            <Show when={fieldError("name")}>{(message) => <span class="tsk-error">{message()}</span>}</Show>
          </label>

          <fieldset class="tsk-field" data-testid="preset-editor-placement">
            <legend class="tsk-label">Execution</legend>
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
                  <label class="tsk-pick">
                    <input
                      type="checkbox"
                      data-testid={`preset-editor-slot-${slot}`}
                      checked={props.draft.configurations[slot] !== null}
                      onChange={(event) => setConfiguration(slot, event.currentTarget.checked ? EMPTY_CONFIGURATION : null)}
                    />
                    <span>{SLOT_LABELS[slot]}</span>
                  </label>
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

          <label class="tsk-field">
            <span class="tsk-label">Instructions</span>
            <textarea
              class="tsk-textarea"
              data-testid="preset-editor-instructions"
              placeholder="What this agent should always do, whatever the task says"
              aria-invalid={fieldError("instructions") ? "true" : undefined}
              value={props.draft.instructions}
              onInput={(event) => patch({ instructions: event.currentTarget.value })}
            />
            <Show when={fieldError("instructions")}>{(message) => <span class="tsk-error">{message()}</span>}</Show>
          </label>

          <section class="tsk-stack" aria-label="Capabilities">
            <h3 class="tsk-section-title">Capabilities</h3>
            <Show
              when={isCloud()}
              fallback={
                <p class="tsk-hint" data-testid="preset-editor-local-capabilities">
                  {LOCAL_CAPABILITY_TEXT}
                </p>
              }
            >
              <CapabilityPicker draft={props.draft} catalog={props.catalog} onDraftChange={props.onDraftChange} />
            </Show>
          </section>
        </div>

        <aside class="tsk-panel">
          <h3 class="tsk-section-title">Resolved configuration</h3>
          <dl class="tsk-kv">
            <dt>Name</dt>
            <dd>{props.draft.name.trim() || "Untitled preset"}</dd>
            <dt>Placement</dt>
            <dd>{PLACEMENT_LABELS[props.draft.placement]}</dd>
            <dt>Primary</dt>
            <dd class="tsk-mono">{configurationSummary(props.draft.configurations.primary)}</dd>
            <dt>Slots</dt>
            <dd>
              {CONFIGURATION_SLOTS.filter((slot) => props.draft.configurations[slot])
                .map((slot) => SLOT_LABELS[slot])
                .join(" · ")}
            </dd>
            <dt>Capabilities</dt>
            <dd>
              {isCloud()
                ? `${props.draft.plugins.length} plugins · ${props.draft.skills.length} skills`
                : LOCAL_CAPABILITY_TEXT}
            </dd>
          </dl>
          <p class="tsk-hint">Saving stores settings. It installs nothing, connects nothing and starts nothing.</p>
        </aside>
      </div>

      <Show when={props.error}>{(message) => <p class="tsk-error" role="alert">{message()}</p>}</Show>

      <div class="tsk-dialog-actions">
        <button type="button" class="tsk-button" data-testid="preset-editor-cancel" onClick={() => props.onCancel()}>
          Cancel
        </button>
        <button type="submit" class="tsk-button" data-variant="primary" data-testid="preset-editor-submit" disabled={props.busy}>
          {props.submitLabel}
        </button>
      </div>
    </form>
  )
}

/** The half-chosen state is representable, so the summary names what is still missing. */
function configurationSummary(configuration: ConfigurationDraft | null) {
  if (!configuration) return "Not configured"
  const parts = [configuration.harness?.id, configuration.model?.modelID, configuration.effort].filter(Boolean)
  return parts.length > 0 ? parts.join(" · ") : "Nothing chosen yet"
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
  const pluginSelected = (sourceId: string, name: string) =>
    props.draft.plugins.some((entry) => entry.sourceId === sourceId && entry.pluginName === name)
  const skillSelected = (sourceId: string, name: string) =>
    props.draft.skills.some((entry) => entry.sourceId === sourceId && entry.skillName === name)

  return (
    <div class="tsk-stack" data-testid="preset-editor-cloud-capabilities">
      <p class="tsk-hint">
        Cloud runs only what you select here, plus the platform tools every session needs. An empty selection means none
        of these optional capabilities.
      </p>
      <Show when={catalog().error}>{(message) => <p class="tsk-error">{message()}</p>}</Show>
      <Show when={catalog().loading}>
        <p class="tsk-hint">Loading installed capabilities…</p>
      </Show>

      <span class="tsk-label">Plugins</span>
      <div class="tsk-capability-list" data-testid="preset-editor-plugins">
        <For each={catalog().plugins} fallback={<span class="tsk-hint">No installed plugins.</span>}>
          {(option) => (
            <label
              class="tsk-pick"
              title={[option.description, option.bundledSkills?.length ? `Bundled skills: ${option.bundledSkills.join(", ")}` : undefined]
                .filter(Boolean)
                .join(" — ")}
            >
              <input
                type="checkbox"
                data-testid={`preset-editor-plugin-${option.key}`}
                checked={pluginSelected(option.sourceId, option.name)}
                disabled={!option.available && !pluginSelected(option.sourceId, option.name)}
                onChange={() =>
                  props.onDraftChange({
                    ...props.draft,
                    plugins: togglePluginReference(props.draft.plugins, { sourceId: option.sourceId, pluginName: option.name }),
                  })
                }
              />
              <span class="tsk-truncate">{option.label}</span>
              <Show when={!option.available}>
                <span class="tsk-error">{option.unavailableReason ?? "Unavailable"}</span>
              </Show>
            </label>
          )}
        </For>
      </div>

      <span class="tsk-label">Skills</span>
      <div class="tsk-capability-list" data-testid="preset-editor-skills">
        <For each={catalog().skills} fallback={<span class="tsk-hint">No installed skills.</span>}>
          {(option) => (
            <label class="tsk-pick" title={option.description}>
              <input
                type="checkbox"
                data-testid={`preset-editor-skill-${option.key}`}
                checked={skillSelected(option.sourceId, option.name)}
                disabled={!option.available && !skillSelected(option.sourceId, option.name)}
                onChange={() =>
                  props.onDraftChange({
                    ...props.draft,
                    skills: toggleSkillReference(props.draft.skills, { sourceId: option.sourceId, skillName: option.name }),
                  })
                }
              />
              <span class="tsk-truncate">{option.label}</span>
              <Show when={!option.available}>
                <span class="tsk-error">{option.unavailableReason ?? "Unavailable"}</span>
              </Show>
            </label>
          )}
        </For>
      </div>
      <p class="tsk-hint">A selected skill adds guidance only. It does not enable the plugin that supplies it.</p>
    </div>
  )
}
