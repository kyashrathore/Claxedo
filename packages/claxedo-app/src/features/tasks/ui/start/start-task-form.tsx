import { For, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Checkbox } from "@opencode-ai/ui/checkbox"
import { Select } from "@opencode-ai/ui/select"
import { TextField } from "@opencode-ai/ui/text-field"
import { CONFIGURATION_SLOTS, TASKS_BOUNDS, type ConfigurationSlot, type Preset } from "@claxedo/tasks"
import { ListFailureNotice, type ListFailure } from "../shared/list-failure"
import { LoadMore, type MorePages } from "../shared/load-more"
import { CapabilityNotice } from "../shared/capability-notice"
import { PLACEMENT_LABELS, SLOT_LABELS, type StartDraft, type StartPreviewState } from "../../view-model"

export type StartTaskFormProps = {
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
  onDraftChange: (draft: StartDraft) => void
  /** Presets are kept in the host's settings; this dialog only chooses among them. */
  onOpenPresetSettings: () => void
  onStart: () => void
  onCancel: () => void
}

/**
 * Start is a small dialog, not a settings panel. A preset is required and
 * nothing is chosen on the user's behalf: with none saved, the dialog says so
 * and points at the settings section that holds them.
 */
export function StartTaskForm(props: StartTaskFormProps) {
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
    <section class="tsk tsk-start" data-testid="start-task-dialog" aria-label={`Start ${props.taskTitle}`}>
      <header class="tsk-start-head">
        <h2 class="tsk-title tsk-truncate">{props.taskTitle}</h2>
        <span class="tsk-hint">Attempt {props.attempt}</span>
      </header>

      <ListFailureNotice failure={props.presetsFailure} testId="start-task-presets-retry" />
      <Show
        when={props.presets.length > 0}
        fallback={
          <Show when={props.presetsFailure === undefined}>
            <div class="tsk-start-empty" data-testid="start-task-no-presets">
              <p class="tsk-hint">A preset is required to start, and you have none yet. There is no default.</p>
              <Button
                size="small"
                variant="primary"
                data-testid="start-task-preset-settings"
                onClick={() => props.onOpenPresetSettings()}
              >
                Create a preset in Settings
              </Button>
            </div>
          </Show>
        }
      >
        <div class="tsk-fields">
          <div class="tsk-field">
            <span class="tsk-label">Preset</span>
            <Select
              size="small"
              options={[...props.presets]}
              current={selected()}
              value={(preset: Preset) => preset.id}
              label={(preset: Preset) => preset.name}
              placeholder="Choose a preset…"
              triggerProps={{ "data-testid": "start-task-preset", "aria-label": "Preset" }}
              onSelect={(preset) => patch({ presetId: preset?.id ?? null })}
            />
          </div>

          <div class="tsk-field">
            <span class="tsk-label">Configuration</span>
            <Select
              size="small"
              disabled={!selected()}
              options={[...slots()]}
              current={props.draft.slot}
              value={(slot: ConfigurationSlot) => slot}
              label={(slot: ConfigurationSlot) => SLOT_LABELS[slot]}
              placeholder="Primary"
              triggerProps={{ "data-testid": "start-task-slot", "aria-label": "Configuration" }}
              onSelect={(slot) => {
                if (slot) patch({ slot })
              }}
            />
          </div>
        </div>

        <div class="tsk-row">
          <LoadMore more={props.morePresets} testId="start-task-presets-load-more" />
          <Button
            size="small"
            variant="ghost"
            data-testid="start-task-preset-settings"
            onClick={() => props.onOpenPresetSettings()}
          >
            Manage presets in Settings
          </Button>
        </div>
      </Show>

      <StartPreview preview={props.preview} attempt={props.attempt} />

      <div class="tsk-field">
        <span class="tsk-label">Handoff text</span>
        <TextField
          multiline
          data-testid="start-task-handoff"
          aria-label="Handoff text"
          maxLength={TASKS_BOUNDS.handoffTextMaxBytes}
          placeholder="Anything the new session should know that the task text does not say"
          value={props.draft.handoffText}
          onChange={(handoffText: string) => patch({ handoffText })}
        />
      </div>

      <Show when={preview()?.previousTranscriptReadable}>
        <div class="tsk-continue" data-testid="start-task-continue-row">
          <Checkbox
            data-testid="start-task-continue"
            checked={props.draft.continueFromPrevious}
            description="Renders the previous session's turns and tool output into this one's instructions."
            onChange={(continueFromPrevious: boolean) => patch({ continueFromPrevious })}
          >
            Continue from{" "}
            {preview()?.currentSession ? `the previous session (${preview()?.currentSession?.liveness})` : "the previous session"}
          </Checkbox>
        </div>
      </Show>

      <Show when={props.error}>{(message) => <p class="tsk-error" role="alert">{message()}</p>}</Show>

      <div class="tsk-dialog-actions">
        <Button size="small" variant="ghost" data-testid="start-task-cancel" onClick={() => props.onCancel()}>
          Cancel
        </Button>
        <Button
          size="small"
          variant="primary"
          data-testid="start-task-submit"
          disabled={!canStart()}
          onClick={() => props.onStart()}
        >
          Start
        </Button>
      </div>
    </section>
  )
}

function StartPreview(props: { preview: StartPreviewState; attempt: number }) {
  const resolved = () => (props.preview.status === "ready" ? props.preview.preview : undefined)

  return (
    <section class="tsk-preview" data-testid="start-task-preview" aria-label="Where this will run">
      <div class="tsk-preview-head">
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
              <dt>Capabilities</dt>
              <dd>
                <CapabilityNotice
                  placement={preview().capabilities.mode === "inherit-local" ? "local" : "cloud"}
                  testId="start-task-preview-capabilities"
                />
              </dd>
            </dl>
            <For each={preview().blockers}>
              {(blocker) => (
                <p class="tsk-blocker" data-testid={`start-task-blocker-${blocker.code}`}>
                  {blocker.detail}
                </p>
              )}
            </For>
          </>
        )}
      </Show>
    </section>
  )
}
