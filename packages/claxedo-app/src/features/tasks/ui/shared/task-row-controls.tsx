import { For, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { CONFIGURATION_SLOTS, type ConfigurationSlot, type Preset, type TaskStatus, type TaskSummary } from "@claxedo/tasks"
import { StatusMenuItems } from "./status-control"
import { SLOT_LABELS } from "../../view-model"

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
          <Button
            size="small"
                       data-testid={`${props.testIdPrefix}-start-${props.task.id}`}
            aria-label={`Start ${props.task.title}`}
            disabled={!startable() || !preset()}
            onClick={() => {
              const entry = preset()
              if (entry) props.offer.onStart({ presetId: entry.id, slot: "primary" })
            }}
          >
            Start
          </Button>
        }
      >
        {(open) => (
          <Button
            size="small"
                       data-testid={`${props.testIdPrefix}-open-session-${props.task.id}`}
            aria-label={`Open the session for ${props.task.title}`}
            onClick={() => open()()}
          >
            Open
          </Button>
        )}
      </Show>

      <DropdownMenu placement="bottom-end">
        <DropdownMenu.Trigger
          as={IconButton}
          icon="chevron-down"
          size="small"
                   data-testid={`${props.testIdPrefix}-start-menu-${props.task.id}`}
          aria-label={`Start ${props.task.title} with a preset`}
          disabled={props.task.archivedAt !== null}
        />
        <DropdownMenu.Portal>
          <DropdownMenu.Content class="tsk-menu-content">
            <Show when={props.offer.blocker}>
              {(message) => (
                <>
                  <p class="tsk-menu-note" data-testid={`${props.testIdPrefix}-start-blocker-${props.task.id}`}>
                    {message()}
                  </p>
                  <DropdownMenu.Separator />
                </>
              )}
            </Show>
            <Show
              when={props.offer.presets.length > 0}
              fallback={
                <>
                  <p class="tsk-menu-note">A preset is required to start, and you have none yet.</p>
                  <DropdownMenu.Item
                    class="tsk-menu-item"
                    data-testid={`${props.testIdPrefix}-preset-settings-${props.task.id}`}
                    onSelect={() => props.offer.onOpenPresetSettings()}
                  >
                    <Icon name="settings-gear" size="small" />
                    <span class="tsk-menu-label">Create a preset in Settings</span>
                  </DropdownMenu.Item>
                </>
              }
            >
              <DropdownMenu.Group>
                <DropdownMenu.GroupLabel>Start with</DropdownMenu.GroupLabel>
                <For each={props.offer.presets}>
                  {(entry) => (
                    <For each={slotsOf(entry)}>
                      {(slot) => (
                        <DropdownMenu.Item
                          class="tsk-menu-item"
                          data-testid={`${props.testIdPrefix}-start-${props.task.id}-${entry.id}-${slot}`}
                          disabled={!startable()}
                          onSelect={() => props.offer.onStart({ presetId: entry.id, slot })}
                        >
                          <Icon name="new-session" size="small" />
                          <span class="tsk-menu-label">{entry.name}</span>
                          <Show when={slotsOf(entry).length > 1}>
                            <span class="tsk-menu-detail">{SLOT_LABELS[slot]}</span>
                          </Show>
                        </DropdownMenu.Item>
                      )}
                    </For>
                  )}
                </For>
              </DropdownMenu.Group>
              <DropdownMenu.Separator />
              <DropdownMenu.Item
                class="tsk-menu-item"
                data-testid={`${props.testIdPrefix}-preset-settings-${props.task.id}`}
                onSelect={() => props.offer.onOpenPresetSettings()}
              >
                <Icon name="settings-gear" size="small" />
                <span class="tsk-menu-label">Manage presets in Settings</span>
              </DropdownMenu.Item>
            </Show>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu>
    </span>
  )
}

/**
 * The row's own menu, which is where status lives once the rows are grouped by
 * it. The group header and the board column already name the status, so the
 * row carries the control rather than a second label.
 */
export function TaskRowActions(props: {
  task: TaskSummary
  busy?: boolean
  testIdPrefix: string
  statusTestId: string
  onStatusChange: (input: { taskId: string; revision: number; status: TaskStatus }) => void
}) {
  return (
    <DropdownMenu placement="bottom-end">
      <DropdownMenu.Trigger
        as={IconButton}
        icon="three-dots"
        size="small"
        variant="ghost"
               data-testid={`${props.testIdPrefix}-actions-${props.task.id}`}
        aria-label={`Actions for ${props.task.title}`}
      />
      <DropdownMenu.Portal>
        <DropdownMenu.Content class="tsk-menu-content">
          <DropdownMenu.Group>
            <DropdownMenu.GroupLabel>Status</DropdownMenu.GroupLabel>
            <StatusMenuItems
              status={props.task.status}
              disabled={props.busy || props.task.archivedAt !== null}
              label={`Status of ${props.task.title}`}
              testId={props.statusTestId}
              onChange={(status) =>
                props.onStatusChange({ taskId: props.task.id, revision: props.task.revision, status })
              }
            />
          </DropdownMenu.Group>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
}
