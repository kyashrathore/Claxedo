import { createSignal, For, Show, type JSX } from "solid-js"
import type { Preset, TaskStatus, TaskSummary } from "@claxedo/tasks"
import { useTranslator } from "@/i18n"
import { Button, DropdownMenu, Icon, IconButton } from "@/ui"
import type { TaskStartOffer } from "../data/start"
import { tasksDictionary } from "../i18n"
import { SLOT_KEYS, configuredSlotsOf } from "../model"
import { ListFailureNotice, LoadMore } from "./load-more"
import { StatusMenuItems } from "./status-control"

type StartTask = Pick<TaskSummary, "id" | "title" | "archivedAt">

function MainPart(props: {
  readonly task: StartTask
  readonly offer: TaskStartOffer
  readonly testIdPrefix: string
}): JSX.Element {
  const t = useTranslator(tasksDictionary)
  const preset = () => props.offer.presets.find((entry) => entry.id === props.offer.defaultPresetId)
  const label = () => props.offer.startLabel ?? t("tasks.start.start")
  const startable = () => props.task.archivedAt === null && props.offer.busy !== true
  return (
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
          aria-label={t("tasks.start.openSessionFor", { title: props.task.title })}
          onClick={() => open()()}
        >
          {t("tasks.start.open")}
        </Button>
      )}
    </Show>
  )
}

function PresetItems(props: {
  readonly task: StartTask
  readonly offer: TaskStartOffer
  readonly testIdPrefix: string
}): JSX.Element {
  const t = useTranslator(tasksDictionary)
  const slotsOf = (entry: Preset) => (props.offer.slot ? [props.offer.slot] : configuredSlotsOf(entry))
  const startable = () => props.task.archivedAt === null && props.offer.busy !== true
  return (
    <DropdownMenu.Group>
      <DropdownMenu.GroupLabel>{t("tasks.start.startWith")}</DropdownMenu.GroupLabel>
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
                  <span class="tsk-menu-detail">{t(SLOT_KEYS[slot])}</span>
                </Show>
              </DropdownMenu.Item>
            )}
          </For>
        )}
      </For>
    </DropdownMenu.Group>
  )
}

function ContinueItem(props: {
  readonly task: StartTask
  readonly offer: TaskStartOffer
  readonly testIdPrefix: string
}): JSX.Element {
  const t = useTranslator(tasksDictionary)
  return (
    <Show when={props.offer.onContinue}>
      {(run) => (
        <>
          <DropdownMenu.Group>
            <DropdownMenu.GroupLabel>{t("tasks.start.continue")}</DropdownMenu.GroupLabel>
            <DropdownMenu.Item
              class="tsk-menu-item"
              data-testid={`${props.testIdPrefix}-continue-${props.task.id}`}
              disabled={props.task.archivedAt !== null || props.offer.busy === true}
              onSelect={() => run()()}
            >
              <Icon name="fork" size="small" />
              <span class="tsk-menu-label">{t("tasks.start.continueFromPrevious")}</span>
            </DropdownMenu.Item>
          </DropdownMenu.Group>
          <DropdownMenu.Separator />
        </>
      )}
    </Show>
  )
}

function PresetSettingsItem(props: {
  readonly task: StartTask
  readonly offer: TaskStartOffer
  readonly testIdPrefix: string
  readonly label: string
}): JSX.Element {
  return (
    <DropdownMenu.Item
      class="tsk-menu-item"
      data-testid={`${props.testIdPrefix}-preset-settings-${props.task.id}`}
      onSelect={() => props.offer.onOpenPresetSettings()}
    >
      <Icon name="settings-gear" size="small" />
      <span class="tsk-menu-label">{props.label}</span>
    </DropdownMenu.Item>
  )
}

function StartMenu(props: {
  readonly task: StartTask
  readonly offer: TaskStartOffer
  readonly testIdPrefix: string
}): JSX.Element {
  const t = useTranslator(tasksDictionary)
  const none = () =>
    props.offer.slot
      ? t("tasks.start.noPresetForSlot", { slot: t(SLOT_KEYS[props.offer.slot]) })
      : t("tasks.start.noPreset")
  return (
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
      <ContinueItem {...props} />
      <Show
        when={props.offer.presets.length > 0}
        fallback={
          <Show when={props.offer.presetsFailure === undefined}>
            <p class="tsk-menu-note">{none()}</p>
            <PresetSettingsItem {...props} label={t("tasks.start.createPreset")} />
          </Show>
        }
      >
        <PresetItems {...props} />
        <LoadMore more={props.offer.morePresets} testId={`${props.testIdPrefix}-presets-load-more-${props.task.id}`} />
        <DropdownMenu.Separator />
        <PresetSettingsItem {...props} label={t("tasks.start.managePresets")} />
      </Show>
    </DropdownMenu.Content>
  )
}

export function TaskStartControl(props: {
  readonly task: StartTask
  readonly offer: TaskStartOffer
  readonly testIdPrefix: string
  readonly onMenuOpenChange?: (open: boolean) => void
}): JSX.Element {
  const t = useTranslator(tasksDictionary)
  return (
    <span class="tsk-split" data-busy={props.offer.busy ? "true" : undefined}>
      <MainPart {...props} />
      <DropdownMenu placement="bottom-end" onOpenChange={props.onMenuOpenChange}>
        <DropdownMenu.Trigger
          as={IconButton}
          icon={<Icon name="chevron-down" size="small" />}
          size="small"
          data-testid={`${props.testIdPrefix}-start-menu-${props.task.id}`}
          aria-label={t("tasks.start.withPreset", { title: props.task.title })}
          disabled={props.task.archivedAt !== null}
        />
        <DropdownMenu.Portal>
          <StartMenu {...props} />
        </DropdownMenu.Portal>
      </DropdownMenu>
    </span>
  )
}

export function TaskRowActions(props: {
  readonly task: TaskSummary
  readonly busy?: boolean
  readonly testIdPrefix: string
  readonly onStatusChange: (input: { taskId: string; revision: number; status: TaskStatus }) => void
  readonly onMenuOpenChange?: (open: boolean) => void
}): JSX.Element {
  const t = useTranslator(tasksDictionary)
  return (
    <DropdownMenu placement="bottom-end" onOpenChange={props.onMenuOpenChange}>
      <DropdownMenu.Trigger
        as={IconButton}
        icon={<Icon name="three-dots" size="small" />}
        size="small"
        variant="ghost"
        data-testid={`${props.testIdPrefix}-actions-${props.task.id}`}
        aria-label={t("tasks.row.actions", { title: props.task.title })}
      />
      <DropdownMenu.Portal>
        <DropdownMenu.Content class="tsk-menu-content">
          <DropdownMenu.Group>
            <DropdownMenu.GroupLabel>{t("tasks.row.status")}</DropdownMenu.GroupLabel>
            <StatusMenuItems
              status={props.task.status}
              disabled={props.busy || props.task.archivedAt !== null}
              label={t("tasks.row.statusOf", { title: props.task.title })}
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

export function createRowToolsMenus() {
  const [open, setOpen] = createSignal<ReadonlySet<string>>(new Set())
  return {
    open: () => open().size > 0,
    track: (menu: string) => (isOpen: boolean) =>
      setOpen((current) => {
        const next = new Set(current)
        if (isOpen) next.add(menu)
        else next.delete(menu)
        return next
      }),
  }
}
