import { For, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import type { ConfigurationSlot, Preset, TaskStatus, TaskSummary } from "@claxedo/tasks"
import { ListFailureNotice, type ListFailure } from "./list-failure"
import { LoadMore, type MorePages } from "./load-more"
import { StatusMenuItems } from "./status-control"
import { SLOT_LABELS, configuredSlotsOf } from "../../view-model"

export type StartChoice = { presetId: string; slot: ConfigurationSlot }

/** What a Start control may offer. The task page builds one per slot; a row builds one for the task. */
export type TaskStartOffer = {
  presets: readonly Preset[]
  /** The preset a bare Start uses: the last one started in this scope, else the only or first saved one. */
  defaultPresetId: string | undefined
  /** The one slot this control belongs to; absent on a row, whose menu spans every slot a preset configures. */
  slot?: ConfigurationSlot
  /** The word on the main part: "Start" unless the slot has run and its session is gone. */
  startLabel?: string
  /** A refusal the surface already knows about — no preset saved, or the last start was refused here. */
  blocker?: string
  busy?: boolean
  /** A refused preset read. While it stands the menu offers the retry rather than an empty catalog. */
  presetsFailure?: ListFailure
  /** The rest of an incomplete preset list: one missing from it cannot be chosen. */
  morePresets?: MorePages
  onStart: (choice: StartChoice) => void
  /** Starts the next attempt with the previous session rendered into it; absent where there is none to read. */
  onContinue?: () => void
  /** Present only where the task already has a session to open. */
  onOpen?: () => void
  /** Presets are kept in the host's settings, which is where a control sends the user to make one. */
  onOpenPresetSettings: () => void
}

/**
 * Start, or Open once the task has a session, with the alternatives behind a
 * caret.
 *
 * The main part commits to one preset so the common case is one press; the
 * caret is where a different preset, a configuration other than Primary, or
 * the previous session is chosen. Every one of them runs the same
 * preview-and-start, so there is no second way to start a task.
 */
export function TaskStartControl(props: {
  task: Pick<TaskSummary, "id" | "title" | "archivedAt">
  offer: TaskStartOffer
  testIdPrefix: string
}) {
  const preset = () => props.offer.presets.find((entry) => entry.id === props.offer.defaultPresetId)
  const slotsOf = (entry: Preset) => (props.offer.slot ? [props.offer.slot] : configuredSlotsOf(entry))
  const label = () => props.offer.startLabel ?? "Start"
  const startable = () => props.task.archivedAt === null && props.offer.busy !== true

  return (
    <span class="tsk-split" data-busy={props.offer.busy ? "true" : undefined}>
      <Show
        when={props.offer.onOpen}
        fallback={
          <Button
            size="small"
            data-testid={`${props.testIdPrefix}-start-${props.task.id}`}
            aria-label={`${label()} ${props.task.title}`}
            disabled={!startable() || !preset()}
            onClick={() => {
              const entry = preset()
              if (entry) props.offer.onStart({ presetId: entry.id, slot: props.offer.slot ?? "primary" })
            }}
          >
            {label()}
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
            <ListFailureNotice
              failure={props.offer.presetsFailure}
              testId={`${props.testIdPrefix}-presets-retry-${props.task.id}`}
            />
            <Show when={props.offer.onContinue}>
              {(run) => (
                <>
                  <DropdownMenu.Group>
                    <DropdownMenu.GroupLabel>Continue</DropdownMenu.GroupLabel>
                    <DropdownMenu.Item
                      class="tsk-menu-item"
                      data-testid={`${props.testIdPrefix}-continue-${props.task.id}`}
                      disabled={!startable()}
                      onSelect={() => run()()}
                    >
                      <Icon name="fork" size="small" />
                      <span class="tsk-menu-label">Continue from previous session</span>
                    </DropdownMenu.Item>
                  </DropdownMenu.Group>
                  <DropdownMenu.Separator />
                </>
              )}
            </Show>
            <Show
              when={props.offer.presets.length > 0}
              fallback={
                <Show when={props.offer.presetsFailure === undefined}>
                  <p class="tsk-menu-note">
                    {props.offer.slot
                      ? `No preset configures ${SLOT_LABELS[props.offer.slot]} yet.`
                      : "A preset is required to start, and you have none yet."}
                  </p>
                  <DropdownMenu.Item
                    class="tsk-menu-item"
                    data-testid={`${props.testIdPrefix}-preset-settings-${props.task.id}`}
                    onSelect={() => props.offer.onOpenPresetSettings()}
                  >
                    <Icon name="settings-gear" size="small" />
                    <span class="tsk-menu-label">Create a preset in Settings</span>
                  </DropdownMenu.Item>
                </Show>
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
              <LoadMore
                more={props.offer.morePresets}
                testId={`${props.testIdPrefix}-presets-load-more-${props.task.id}`}
              />
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
              testId={`${props.testIdPrefix}-status-${props.task.id}`}
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
