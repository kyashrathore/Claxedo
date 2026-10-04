import { For, Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { Button, Icon, IconButton } from "@/ui"
import { tasksDictionary } from "../i18n"
import { openableSlot } from "../model"
import { StatusControl } from "./status-control"
import type { TaskDetailProps } from "./task-detail"
import { SlotRow } from "./task-slot"

function Properties(props: TaskDetailProps): JSX.Element {
  const t = useTranslator(tasksDictionary)
  const task = () => props.view.task
  const presetName = () => openableSlot(props.view.groups)?.current.presetNameAtStart
  return (
    <div class="tsk-props-list">
      <StatusControl
        status={task().status}
        disabled={props.busy || task().archivedAt !== null}
        label={t("tasks.detail.status")}
        testId="task-detail-status"
        onChange={(status) => props.onStatusChange({ taskId: task().id, revision: task().revision, status })}
      />
      <div class="tsk-prop" role="group" aria-label={t("tasks.detail.project")}>
        <Icon name="folder" size="small" />
        <span class="tsk-truncate">{props.projectLabel}</span>
      </div>
      <Show when={presetName()}>
        {(name) => (
          <div class="tsk-prop" role="group" aria-label={t("tasks.detail.preset")}>
            <Icon name="sliders" size="small" />
            <span class="tsk-truncate">{name()}</span>
          </div>
        )}
      </Show>
      <Show when={task().workspaceId}>
        {(workspaceId) => (
          <div class="tsk-prop" role="group" aria-label={t("tasks.detail.workspace")}>
            <Icon name="server" size="small" />
            <span class="tsk-truncate">{workspaceId()}</span>
          </div>
        )}
      </Show>
      <Show when={task().createdFrom}>
        {(session) => (
          <button
            type="button"
            class="tsk-prop tsk-prop-link"
            data-testid="task-detail-created-from"
            onClick={() => props.onOpenSession(session())}
          >
            <Icon name="comment" size="small" />
            <span class="tsk-truncate">{t("tasks.detail.createdFrom")}</span>
          </button>
        )}
      </Show>
    </div>
  )
}

function ArchiveAction(props: TaskDetailProps): JSX.Element {
  const t = useTranslator(tasksDictionary)
  return (
    <Show
      when={props.view.task.archivedAt === null}
      fallback={
        <Button
          size="small"
          variant="ghost"
          class="tsk-rail-action"
          data-testid="task-detail-restore"
          onClick={() => props.onRestore()}
        >
          {t("tasks.detail.restore")}
        </Button>
      }
    >
      <Button
        size="small"
        variant="ghost"
        class="tsk-rail-action tsk-destructive"
        data-testid="task-detail-archive"
        onClick={() => props.onArchive()}
      >
        {t("tasks.detail.archive")}
      </Button>
    </Show>
  )
}

export function TaskRail(props: TaskDetailProps): JSX.Element {
  const t = useTranslator(tasksDictionary)
  return (
    <aside id="task-detail-rail" class="tsk-rail" data-testid="task-detail-rail" inert={props.railCollapsed === true}>
      <section class="tsk-rail-section" aria-label={t("tasks.detail.properties")}>
        <div class="tsk-rail-head">
          <h3 class="tsk-section-title tsk-rail-title">{t("tasks.detail.properties")}</h3>
          <IconButton
            icon={<Icon name="chevron-double-right" size="small" />}
            size="small"
            variant="ghost-muted"
            data-testid="task-detail-rail-collapse"
            aria-label={t("tasks.detail.hideProperties")}
            aria-expanded={true}
            aria-controls="task-detail-rail"
            onClick={() => props.onToggleRail()}
          />
        </div>
        <Properties {...props} />
      </section>
      <section class="tsk-rail-section" aria-label={t("tasks.detail.linkedSessions")}>
        <h3 class="tsk-section-title tsk-rail-title">{t("tasks.detail.sessions")}</h3>
        <Show
          when={props.view.configuredSlots.length > 0}
          fallback={<p class="tsk-hint">{t("tasks.detail.choosePreset")}</p>}
        >
          <div class="tsk-slots">
            <For each={props.view.configuredSlots}>
              {(slot) => (
                <SlotRow
                  slot={slot}
                  task={props.view.task}
                  group={props.view.groups.find((entry) => entry.slot === slot)}
                  offer={props.startOffer(slot)}
                  busy={props.busy}
                  onOpenSession={props.onOpenSession}
                  onSendTask={props.onSendTask}
                />
              )}
            </For>
          </div>
        </Show>
      </section>
      <ArchiveAction {...props} />
    </aside>
  )
}
