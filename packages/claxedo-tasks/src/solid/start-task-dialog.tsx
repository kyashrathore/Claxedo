import { For, Show, type JSX } from "solid-js"
import { CONFIGURATION_SLOTS, TASKS_BOUNDS, isConfigurationSlot, type Preset } from "../contracts"
import { ListFailureNotice, type ListFailure } from "./list-failure"
import { LoadMore, type MorePages } from "./load-more"
import { CapabilityNotice } from "./capability-notice"
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
      <div class="tsk-stack">
        <span class="tsk-eyebrow">Start attempt {props.attempt}</span>
        <h2 class="tsk-title tsk-truncate">{props.taskTitle}</h2>
      </div>

      <Show when={props.inlinePresetEditor} fallback={null}>
        {(editor) => (
          <div class="tsk-panel" data-testid="start-task-inline-preset">
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
                <p class="tsk-hint">A preset is required to start, and you have none yet. There is no default.</p>
                <div>
                  <button
                    type="button"
                    class="tsk-button"
                    data-variant="primary"
                    data-testid="start-task-create-preset"
                    onClick={() => props.onCreatePreset()}
                  >
                    Create a preset
                  </button>
                </div>
              </div>
            </Show>
          }
        >
          <div class="tsk-choosers">
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

            <label class="tsk-field">
              <span class="tsk-label">Configuration</span>
              <select
                class="tsk-select"
                data-testid="start-task-slot"
                disabled={!selected()}
                value={props.draft.slot}
                onChange={(event) => {
                  const next = event.currentTarget.value
                  if (isConfigurationSlot(next)) patch({ slot: next })
                }}
              >
                <For each={slots()}>{(slot) => <option value={slot}>{SLOT_LABELS[slot]}</option>}</For>
              </select>
            </label>
          </div>

          <div class="tsk-row">
            <LoadMore more={props.morePresets} testId="start-task-presets-load-more" />
            <button
              type="button"
              class="tsk-button"
              data-variant="quiet"
              data-testid="start-task-create-preset"
              onClick={() => props.onCreatePreset()}
            >
              Create a preset
            </button>
          </div>
        </Show>

        <StartPreviewPanel preview={props.preview} attempt={props.attempt} />

        <label class="tsk-field">
          <span class="tsk-label">Handoff text</span>
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
              <span>
                Continue from{" "}
                {preview()?.currentSession ? `the previous session (${preview()?.currentSession?.liveness})` : "the previous session"}
              </span>
              <span class="tsk-hint">
                Renders the previous session's turns and tool output into this one's instructions.
              </span>
            </span>
          </label>
        </Show>

        <Show when={props.error}>{(message) => <p class="tsk-error" role="alert">{message()}</p>}</Show>

        <div class="tsk-dialog-actions">
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
  const resolved = () => (props.preview.status === "ready" ? props.preview.preview : undefined)

  return (
    <div class="tsk-panel" data-testid="start-task-preview">
      <div class="tsk-row tsk-spread">
        <h3 class="tsk-section-title">Where this will run</h3>
        <Show when={props.preview.status === "loading" || (props.preview.status === "ready" && props.preview.refreshing === true)}>
          <span class="tsk-hint" data-testid="start-task-preview-resolving">
            Resolving settings…
          </span>
        </Show>
      </div>

      <Show when={props.preview.status === "idle"}>
        <p class="tsk-hint">Choose a preset to see where this will run.</p>
      </Show>
      <Show when={props.preview.status === "error" ? props.preview : undefined}>
        {(failed) => (
          <span class="tsk-error" role="alert" data-testid="start-task-preview-error">
            {failed().message}
          </span>
        )}
      </Show>

      <Show when={resolved()}>
        {(preview) => (
          <>
            <dl class="tsk-kv">
              <dt>Placement</dt>
              <dd>{PLACEMENT_LABELS[preview().placement]}</dd>
              <dt>Workspace</dt>
              <dd>{preview().destinationDescription}</dd>
              <dt>Model</dt>
              <dd class="tsk-mono">
                {preview().configuration.harness.id} · {preview().configuration.model.providerID}/
                {preview().configuration.model.modelID}
              </dd>
              <dt>Effort</dt>
              <dd class="tsk-mono">{preview().configuration.effort ?? "Harness default"}</dd>
              <dt>Capabilities</dt>
              <dd>
                <CapabilityNotice
                  placement={preview().capabilities.mode === "inherit-local" ? "local" : "cloud"}
                  testId="start-task-preview-capabilities"
                />
              </dd>
              <dt>Attempt</dt>
              <dd class="tsk-num">
                #{props.attempt} · {SLOT_LABELS[preview().slot]}
              </dd>
              <Show when={preview().currentSession}>
                {(current) => (
                  <>
                    <dt>Current</dt>
                    <dd>Session for this slot is {current().liveness}</dd>
                  </>
                )}
              </Show>
            </dl>
            <For each={preview().blockers}>
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
