import { For, Show } from "solid-js"
import { CONFIGURATION_SLOTS, type ConfigurationSlot, type Preset, type TaskStatus, type TaskSummary } from "../contracts"
import { RowMenu } from "./row-menu"
import { StatusMenu } from "./status-menu"
import { SLOT_LABELS } from "./view-model"

export type StartChoice = { presetId: string; slot: ConfigurationSlot }

export type TaskStartOffer = {
  presets: readonly Preset[]
  /** The preset a bare Start uses: the last one started in this scope, else the only or first saved one. */
  defaultPresetId: string | undefined
  /** A refusal the row already knows about — no preset saved, or the last start was refused here. */
  blocker?: string
  busy?: boolean
  onStart: (choice: StartChoice) => void
  /** Present only where the task already has a session to open. */
  onOpen?: () => void
  /** Presets are kept in the host's settings, which is where a row sends the user to make one. */
  onOpenPresetSettings: () => void
}

/**
 * Start, or Open once the task has a session, with the alternatives behind a
 * caret.
 *
 * The main part commits to one preset so the common case is one press; the
 * caret is where a different preset or a configuration other than Primary is
 * chosen. Both run the same preview-and-start the dialog runs — a row that
 * started a session another way would be a second path to the same command.
 */
export function TaskStartControl(props: { task: TaskSummary; offer: TaskStartOffer; testIdPrefix: string }) {
  const preset = () => props.offer.presets.find((entry) => entry.id === props.offer.defaultPresetId)
  const slotsOf = (entry: Preset) => CONFIGURATION_SLOTS.filter((slot) => entry.configurations[slot])
  const startable = () => props.task.archivedAt === null && props.offer.busy !== true

  return (
    <span class="tsk-split" data-busy={props.offer.busy ? "true" : undefined}>
      <Show
        when={props.offer.onOpen}
        fallback={
          <button
            type="button"
            class="tsk-split-main"
            data-testid={`${props.testIdPrefix}-start-${props.task.id}`}
            aria-label={`Start ${props.task.title}`}
            disabled={!startable() || !preset()}
            onClick={() => {
              const entry = preset()
              if (entry) props.offer.onStart({ presetId: entry.id, slot: "primary" })
            }}
          >
            Start
          </button>
        }
      >
        {(open) => (
          <button
            type="button"
            class="tsk-split-main"
            data-testid={`${props.testIdPrefix}-open-session-${props.task.id}`}
            aria-label={`Open the session for ${props.task.title}`}
            onClick={() => open()()}
          >
            Open
          </button>
        )}
      </Show>

      <RowMenu
        ariaLabel={`Start ${props.task.title} with a preset`}
        triggerClass="tsk-split-caret"
        triggerTestId={`${props.testIdPrefix}-start-menu-${props.task.id}`}
        disabled={props.task.archivedAt !== null}
        label={<span aria-hidden="true">⌄</span>}
      >
        {(close) => (
          <div class="tsk-menu-body">
            <Show when={props.offer.blocker}>
              {(message) => (
                <p class="tsk-blocker" data-testid={`${props.testIdPrefix}-start-blocker-${props.task.id}`}>
                  {message()}
                </p>
              )}
            </Show>
            <Show
              when={props.offer.presets.length > 0}
              fallback={
                <>
                  <p class="tsk-hint">A preset is required to start, and you have none yet.</p>
                  <button
                    type="button"
                    class="tsk-menu-item"
                    data-testid={`${props.testIdPrefix}-preset-settings-${props.task.id}`}
                    onClick={() => {
                      close()
                      props.offer.onOpenPresetSettings()
                    }}
                  >
                    Create a preset in Settings
                  </button>
                </>
              }
            >
              <For each={props.offer.presets}>
                {(entry) => (
                  <For each={slotsOf(entry)}>
                    {(slot) => (
                      <button
                        type="button"
                        class="tsk-menu-item"
                        data-testid={`${props.testIdPrefix}-start-${props.task.id}-${entry.id}-${slot}`}
                        disabled={!startable()}
                        onClick={() => {
                          close()
                          props.offer.onStart({ presetId: entry.id, slot })
                        }}
                      >
                        <span class="tsk-truncate">{entry.name}</span>
                        <Show when={slotsOf(entry).length > 1}>
                          <span class="tsk-menu-note">{SLOT_LABELS[slot]}</span>
                        </Show>
                      </button>
                    )}
                  </For>
                )}
              </For>
              <button
                type="button"
                class="tsk-menu-item"
                data-testid={`${props.testIdPrefix}-preset-settings-${props.task.id}`}
                onClick={() => {
                  close()
                  props.offer.onOpenPresetSettings()
                }}
              >
                Manage presets in Settings
              </button>
            </Show>
          </div>
        )}
      </RowMenu>
    </span>
  )
}

/**
 * The row's own menu, which is where status lives once the rows are grouped by
 * it. The select is the control, unchanged — the menu only decides when it is
 * on screen.
 */
export function TaskRowActions(props: {
  task: TaskSummary
  busy?: boolean
  testIdPrefix: string
  statusTestId: string
  onStatusChange: (input: { taskId: string; revision: number; status: TaskStatus }) => void
}) {
  return (
    <RowMenu
      ariaLabel={`Actions for ${props.task.title}`}
      triggerClass="tsk-icon-button tsk-row-actions"
      triggerTestId={`${props.testIdPrefix}-actions-${props.task.id}`}
      label={<span aria-hidden="true">⋯</span>}
    >
      {() => (
        <div class="tsk-menu-body">
          <span class="tsk-label">Status</span>
          <StatusMenu
            status={props.task.status}
            disabled={props.busy || props.task.archivedAt !== null}
            label={`Status of ${props.task.title}`}
            testId={props.statusTestId}
            onChange={(status) => props.onStatusChange({ taskId: props.task.id, revision: props.task.revision, status })}
          />
        </div>
      )}
    </RowMenu>
  )
}
