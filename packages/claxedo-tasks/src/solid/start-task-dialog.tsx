import { For, Show, type JSX } from "solid-js"
import { CONFIGURATION_SLOTS, TASKS_BOUNDS, isConfigurationSlot, type Preset } from "../contracts"
import { ListFailureNotice, type ListFailure } from "./list-failure"
import { LoadMore, type MorePages } from "./load-more"
import { PLACEMENT_LABELS, SLOT_LABELS, type StartDraft, type StartPreviewState } from "./view-model"

export type StartTaskDialogProps = {
  taskTitle: string
  attempt: number
  presets: readonly Preset[]
  draft: StartDraft
  preview: StartPreviewState
  busy?: boolean
  error?: string
  /** The chooser's own next page: a preset missing from an incomplete list cannot be chosen. */
  morePresets?: MorePages
  /** A refused preset read. Start offers nothing while it stands: an unread catalog is not an empty one. */
  presetsFailure?: ListFailure
  /** Rendered in place of the chooser while the user creates a preset inline. */
  inlinePresetEditor?: JSX.Element
  onDraftChange: (draft: StartDraft) => void
  onCreatePreset: () => void
  onStart: () => void
  onCancel: () => void
}

/**
 * Start is a small dialog, not a settings panel. A preset is required and
 * nothing is chosen on the user's behalf: with no presets saved the dialog
 * offers to create one and keeps this draft while it does.
 */
export function StartTaskDialog(props: StartTaskDialogProps) {
  const patch = (input: Partial<StartDraft>) => props.onDraftChange({ ...props.draft, ...input })
  const selected = () => props.presets.find((preset) => preset.id === props.draft.presetId)
  const slots = () => CONFIGURATION_SLOTS.filter((slot) => selected()?.configurations[slot])
  const resolved = () => (props.preview.status === "ready" ? props.preview : undefined)
  const preview = () => resolved()?.preview
  const canStart = () =>
    props.busy !== true &&
    !!selected() &&
    resolved()?.refreshing !== true &&
    preview()?.available === true &&
    preview()?.slot === props.draft.slot

  return (
    <section class="tsk tsk-stack" data-testid="start-task-dialog" aria-label={`Start ${props.taskTitle}`}>
      <h2 class="tsk-title">Start “{props.taskTitle}”</h2>

      <Show when={props.inlinePresetEditor} fallback={null}>
        {(editor) => (
          <div class="tsk-surface tsk-stack tsk-panel" data-testid="start-task-inline-preset">
            <h3 class="tsk-section-title">New preset</h3>
            {editor()}
          </div>
        )}
      </Show>

      <Show when={!props.inlinePresetEditor}>
        <ListFailureNotice failure={props.presetsFailure} testId="start-task-presets-retry" />
        <Show
          when={props.presets.length > 0}
          fallback={
            <Show when={props.presetsFailure === undefined}>
              <div class="tsk-stack" data-testid="start-task-no-presets">
                <p class="tsk-muted">A preset is required to start, and you have none yet. There is no default.</p>
                <button type="button" class="tsk-button" data-variant="primary" data-testid="start-task-create-preset" onClick={() => props.onCreatePreset()}>
                  Create a preset
                </button>
              </div>
            </Show>
          }
        >
          <label class="tsk-field">
            <span class="tsk-label">Preset</span>
            <select
              class="tsk-select"
              data-testid="start-task-preset"
              value={props.draft.presetId ?? ""}
              onChange={(event) => patch({ presetId: event.currentTarget.value || null })}
            >
              <option value="">Choose a preset…</option>
              <For each={props.presets}>{(preset) => <option value={preset.id}>{preset.name}</option>}</For>
            </select>
          </label>
          <LoadMore more={props.morePresets} testId="start-task-presets-load-more" />
          <button type="button" class="tsk-button" data-testid="start-task-create-preset" onClick={() => props.onCreatePreset()}>
            Create a preset
          </button>

          <Show when={selected()}>
            <label class="tsk-field">
              <span class="tsk-label">Configuration</span>
              <select
                class="tsk-select"
                data-testid="start-task-slot"
                value={props.draft.slot}
                onChange={(event) => {
                  const next = event.currentTarget.value
                  if (isConfigurationSlot(next)) patch({ slot: next })
                }}
              >
                <For each={slots()}>{(slot) => <option value={slot}>{SLOT_LABELS[slot]}</option>}</For>
              </select>
            </label>
          </Show>
        </Show>

        <StartPreviewPanel preview={props.preview} attempt={props.attempt} />

        <label class="tsk-field">
          <span class="tsk-label">Handoff text (optional)</span>
          <textarea
            class="tsk-textarea"
            data-testid="start-task-handoff"
            maxLength={TASKS_BOUNDS.handoffTextMaxBytes}
            placeholder="Anything the new session should know that the task text does not say"
            value={props.draft.handoffText}
            onInput={(event) => patch({ handoffText: event.currentTarget.value })}
          />
        </label>

        <Show when={preview()?.previousTranscriptReadable}>
          <label class="tsk-checkbox" data-testid="start-task-continue-row">
            <input
              type="checkbox"
              data-testid="start-task-continue"
              checked={props.draft.continueFromPrevious}
              onChange={(event) => patch({ continueFromPrevious: event.currentTarget.checked })}
            />
            <span class="tsk-stack">
              <span>Continue from previous session</span>
              <span class="tsk-muted">Renders the previous session's turns and tool output into this one's instructions.</span>
            </span>
          </label>
        </Show>

        <Show when={props.error}>{(message) => <p class="tsk-error" role="alert">{message()}</p>}</Show>

        <div class="tsk-row tsk-spread">
          <button type="button" class="tsk-button" data-testid="start-task-cancel" onClick={() => props.onCancel()}>
            Cancel
          </button>
          <button
            type="button"
            class="tsk-button"
            data-variant="primary"
            data-testid="start-task-submit"
            disabled={!canStart()}
            onClick={() => props.onStart()}
          >
            Start
          </button>
        </div>
      </Show>
    </section>
  )
}

function StartPreviewPanel(props: { preview: StartPreviewState; attempt: number }) {
  return (
    <div class="tsk-preview" data-testid="start-task-preview">
      <Show when={props.preview.status === "idle"}>
        <span class="tsk-muted">Choose a preset to see where this will run.</span>
      </Show>
      <Show when={props.preview.status === "loading" || (props.preview.status === "ready" && props.preview.refreshing === true)}>
        <span class="tsk-muted" data-testid="start-task-preview-resolving">Resolving settings…</span>
      </Show>
      <Show when={props.preview.status === "error" ? props.preview : undefined}>
        {(failed) => (
          <span class="tsk-error" role="alert" data-testid="start-task-preview-error">
            {failed().message}
          </span>
        )}
      </Show>
      <Show when={props.preview.status === "ready" ? props.preview.preview : undefined}>
        {(resolved) => (
          <>
            <span>
              {PLACEMENT_LABELS[resolved().placement]} · {SLOT_LABELS[resolved().slot]} · attempt {props.attempt}
            </span>
            <span class="tsk-muted">{resolved().destinationDescription}</span>
            <span class="tsk-muted">
              {resolved().configuration.harness.id} · {resolved().configuration.model.providerID}/
              {resolved().configuration.model.modelID}
              {resolved().configuration.effort ? ` · ${resolved().configuration.effort}` : ""}
            </span>
            <span class="tsk-muted" data-testid="start-task-preview-capabilities">
              {resolved().capabilities.mode === "inherit-local"
                ? "Uses this machine's current skills and plugins."
                : "Cloud runs only the plugins and skills this preset selects, plus the platform tools every session needs."}
            </span>
            <Show when={resolved().currentSession}>
              {(current) => <span class="tsk-muted">Current session for this slot: {current().liveness}</span>}
            </Show>
            <For each={resolved().blockers}>
              {(blocker) => (
                <span class="tsk-blocker" data-testid={`start-task-blocker-${blocker.code}`}>
                  {blocker.detail}
                </span>
              )}
            </For>
          </>
        )}
      </Show>
    </div>
  )
}
