import { For, Show, createSignal, type JSX } from "solid-js"
import { TASK_STATUSES, type TaskStatus } from "@claxedo/tasks"
import { useTranslator } from "@/i18n"
import { Button, Switch, Tag, IconButton, Popover, Select } from "@/ui"
import { dictionary } from "../i18n"
import type { TaskProject } from "../links"
import {
  TASK_COLLECTIONS,
  TASK_COLLECTION_KEYS,
  TASK_DATE_FIELDS,
  TASK_DATE_FIELD_KEYS,
  TASK_STATUS_KEYS,
  type TaskDateField,
} from "../model"
import type { TasksStore } from "../store"

type ToolbarProps = {
  readonly store: TasksStore
  readonly projects: readonly TaskProject[]
  readonly projectId: string
}

const ANY_STATUS = "any" as const
type StatusChoice = TaskStatus | typeof ANY_STATUS
const STATUS_CHOICES: readonly StatusChoice[] = [ANY_STATUS, ...TASK_STATUSES]
const GROUPINGS = [{ grouped: true }, { grouped: false }] as const
type Grouping = (typeof GROUPINGS)[number]

function trigger(testId: string, icon?: "sliders") {
  return { size: "small" as const, variant: "ghost" as const, icon, "data-testid": testId }
}

function CollectionToggle(props: { readonly store: TasksStore }): JSX.Element {
  const t = useTranslator(dictionary)
  return (
    <div class="tsk-segmented" role="group" aria-label={t("tasks.toolbar.collection")}>
      <For each={TASK_COLLECTIONS}>
        {(collection) => (
          <Button
            size="small"
            variant="ghost"
            data-testid={`tasks-collection-${collection}`}
            data-selected={props.store.state.collection === collection ? "true" : undefined}
            aria-pressed={props.store.state.collection === collection}
            onClick={() => props.store.setCollection(collection)}
          >
            {t(TASK_COLLECTION_KEYS[collection])}
          </Button>
        )}
      </For>
    </div>
  )
}

function FilterTags(props: ToolbarProps): JSX.Element {
  const t = useTranslator(dictionary)
  const project = () => props.projects.find((entry) => entry.id === props.projectId)
  return (
    <>
      <Show when={props.projects.length > 1 && project()}>
        {(entry) => <Tag class="tsk-filter-tag">{t("tasks.toolbar.projectTag", { project: entry().label })}</Tag>}
      </Show>
      <Show when={props.store.state.statusFilter}>
        {(status) => (
          <Tag class="tsk-filter-tag">
            {t(TASK_STATUS_KEYS[status()])}
            <IconButton
              icon="close-small"
              size="small"
              variant="ghost"
              data-testid="tasks-status-filter-clear"
              aria-label={t("tasks.toolbar.clearFilter", { status: t(TASK_STATUS_KEYS[status()]) })}
              onClick={() => props.store.setStatusFilter(null)}
            />
          </Tag>
        )}
      </Show>
    </>
  )
}

function FilterPopover(props: ToolbarProps): JSX.Element {
  const t = useTranslator(dictionary)
  const [open, setOpen] = createSignal(false)
  const project = () => props.projects.find((entry) => entry.id === props.projectId)
  const statusLabel = (choice: StatusChoice) =>
    choice === ANY_STATUS ? t("tasks.toolbar.anyStatus") : t(TASK_STATUS_KEYS[choice])
  return (
    <Popover
      open={open()}
      onOpenChange={setOpen}
      placement="bottom-end"
      triggerAs={Button}
      triggerProps={trigger("tasks-filter")}
      trigger={<span>{t("tasks.toolbar.filter")}</span>}
    >
      <div class="tsk-popover">
        <div class="tsk-option">
          <span class="tsk-option-label">{t("tasks.toolbar.project")}</span>
          <Select
            size="small"
            options={[...props.projects]}
            current={project()}
            value={(entry: TaskProject) => entry.id}
            label={(entry: TaskProject) => entry.label}
            placeholder={t("tasks.toolbar.anyProject")}
            triggerProps={{ "data-testid": "tasks-project", "aria-label": t("tasks.toolbar.project") }}
            onSelect={(entry) => {
              if (entry) props.store.setProjectId(entry.id)
            }}
          />
        </div>
        <div class="tsk-option">
          <span class="tsk-option-label">{t("tasks.toolbar.status")}</span>
          <Select
            size="small"
            options={[...STATUS_CHOICES]}
            current={props.store.state.statusFilter ?? ANY_STATUS}
            value={(choice: StatusChoice) => choice}
            label={statusLabel}
            triggerProps={{ "data-testid": "tasks-status-filter", "aria-label": t("tasks.toolbar.statusFilter") }}
            onSelect={(choice) => props.store.setStatusFilter(choice && choice !== ANY_STATUS ? choice : null)}
          />
        </div>
      </div>
    </Popover>
  )
}

function DisplayPopover(props: { readonly store: TasksStore }): JSX.Element {
  const t = useTranslator(dictionary)
  const [open, setOpen] = createSignal(false)
  const groupingLabel = (entry: Grouping) => t(entry.grouped ? "tasks.toolbar.groupStatus" : "tasks.toolbar.groupNone")
  return (
    <Popover
      open={open()}
      onOpenChange={setOpen}
      placement="bottom-end"
      triggerAs={Button}
      triggerProps={trigger("tasks-display", "sliders")}
      trigger={<span>{t("tasks.toolbar.display")}</span>}
    >
      <div class="tsk-popover">
        <div class="tsk-option">
          <span class="tsk-option-label">{t("tasks.toolbar.showSubtasks")}</span>
          <Switch
            data-testid="tasks-show-children"
            checked={props.store.state.showChildren}
            onChange={(value: boolean) => props.store.setShowChildren(value)}
            hideLabel
          >
            {t("tasks.toolbar.showSubtasks")}
          </Switch>
        </div>
        <div class="tsk-option">
          <span class="tsk-option-label">{t("tasks.toolbar.grouping")}</span>
          <Select
            size="small"
            options={[...GROUPINGS]}
            current={GROUPINGS.find((entry) => entry.grouped === props.store.state.grouped)}
            value={(entry: Grouping) => String(entry.grouped)}
            label={groupingLabel}
            triggerProps={{ "data-testid": "tasks-group-by-status", "aria-label": t("tasks.toolbar.grouping") }}
            onSelect={(entry) => {
              if (entry) props.store.setGrouped(entry.grouped)
            }}
          />
        </div>
        <div class="tsk-option">
          <span class="tsk-option-label">{t("tasks.toolbar.date")}</span>
          <Select
            size="small"
            options={[...TASK_DATE_FIELDS]}
            current={props.store.state.dateField}
            value={(field: TaskDateField) => field}
            label={(field: TaskDateField) => t(TASK_DATE_FIELD_KEYS[field])}
            triggerProps={{ "data-testid": "tasks-date-field", "aria-label": t("tasks.toolbar.date") }}
            onSelect={(field) => {
              if (field) props.store.setDateField(field)
            }}
          />
        </div>
      </div>
    </Popover>
  )
}

function ViewToggle(props: { readonly store: TasksStore }): JSX.Element {
  const t = useTranslator(dictionary)
  const board = () => props.store.state.view === "board"
  return (
    <div class="tsk-segmented" role="group" aria-label={t("tasks.toolbar.view")}>
      <Button
        size="small"
        variant="ghost"
        data-testid={board() ? "tasks-view-toggle" : undefined}
        data-selected={board() ? undefined : "true"}
        aria-pressed={!board()}
        onClick={() => props.store.setView("list")}
      >
        {t("tasks.toolbar.list")}
      </Button>
      <Button
        size="small"
        variant="ghost"
        data-testid={board() ? undefined : "tasks-view-toggle"}
        data-selected={board() ? "true" : undefined}
        aria-pressed={board()}
        onClick={() => props.store.setView("board")}
      >
        {t("tasks.toolbar.board")}
      </Button>
    </div>
  )
}

export function TasksToolbar(props: ToolbarProps): JSX.Element {
  return (
    <div class="tsk-toolbar">
      <CollectionToggle store={props.store} />
      <FilterTags {...props} />
      <span class="tsk-spacer" />
      <FilterPopover {...props} />
      <DisplayPopover store={props.store} />
      <ViewToggle store={props.store} />
    </div>
  )
}
