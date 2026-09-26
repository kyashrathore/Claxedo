import { Show, type JSX } from "solid-js"
import type { ConfigurationSlot, SessionReference, TaskSessionLinkView, TaskStatus } from "@claxedo/tasks"
import { useTranslator } from "@/i18n"
import { Button, IconButton } from "@/ui"
import type { TaskStartOffer } from "../data/start"
import { tasksDictionary } from "../i18n"
import { taskKey, type TaskDetailView } from "../model"
import { ProseField } from "./prose-field"
import { TaskRail } from "./task-rail"
import { TaskTitleField } from "./title-field"

export type TaskDetailEdit = { readonly title: string; readonly description: string }

export type TaskDetailProps = {
  readonly view: TaskDetailView
  readonly edit: TaskDetailEdit
  readonly dirty: boolean
  readonly busy?: boolean
  readonly error?: string
  readonly conflict?: string
  readonly projectLabel: string
  readonly onEditChange: (edit: TaskDetailEdit) => void
  readonly onSave: () => void
  readonly onDiscard: () => void
  readonly onStatusChange: (input: { taskId: string; revision: number; status: TaskStatus }) => void
  readonly onOpenSession: (sessionRef: SessionReference) => void
  readonly startOffer: (slot: ConfigurationSlot) => TaskStartOffer
  readonly onSendTask: (link: TaskSessionLinkView) => void
  readonly onArchive: () => void
  readonly onRestore: () => void
  readonly onBack: () => void
  readonly onOpenProject: () => void
  readonly onOpenParent?: () => void
  readonly railCollapsed?: boolean
  readonly onToggleRail: () => void
  readonly subtasks?: JSX.Element
  readonly attachments?: JSX.Element
}

function ParentCrumb(props: TaskDetailProps): JSX.Element {
  return (
    <Show when={props.view.parent}>
      {(parent) => (
        <>
          <span class="tsk-crumb-sep" aria-hidden="true">
            ›
          </span>
          <Show
            when={props.onOpenParent}
            fallback={
              <span class="tsk-key" title={parent().title}>
                {taskKey(props.projectLabel, parent())}
              </span>
            }
          >
            {(open) => (
              <button
                type="button"
                class="tsk-crumb-link tsk-key"
                data-testid="task-detail-parent-crumb"
                title={parent().title}
                onClick={() => open()()}
              >
                {taskKey(props.projectLabel, parent())}
              </button>
            )}
          </Show>
        </>
      )}
    </Show>
  )
}

function SaveRow(props: TaskDetailProps): JSX.Element {
  const t = useTranslator(tasksDictionary)
  return (
    <Show when={props.dirty} fallback={<span class="tsk-spacer" />}>
      <span class="tsk-spacer" />
      <span class="tsk-page-actions" data-testid="task-detail-save-row">
        <span class="tsk-hint">{t("tasks.detail.unsaved")}</span>
        <Button size="small" variant="ghost" data-testid="task-detail-discard" onClick={() => props.onDiscard()}>
          {t("tasks.detail.discard")}
        </Button>
        <Button
          size="small"
          variant="primary"
          data-testid="task-detail-save"
          disabled={props.busy}
          onClick={() => props.onSave()}
        >
          {t("tasks.detail.save")}
        </Button>
      </span>
    </Show>
  )
}

function Crumbs(props: TaskDetailProps): JSX.Element {
  const t = useTranslator(tasksDictionary)
  const task = () => props.view.task
  return (
    <nav class="tsk-crumbs" aria-label={t("tasks.detail.breadcrumb")}>
      <button type="button" class="tsk-crumb-link" data-testid="task-detail-back" onClick={() => props.onBack()}>
        {t("tasks.title")}
      </button>
      <span class="tsk-crumb-sep" aria-hidden="true">
        ›
      </span>
      <button
        type="button"
        class="tsk-crumb-link"
        data-testid="task-detail-project-crumb"
        onClick={() => props.onOpenProject()}
      >
        {props.projectLabel}
      </button>
      <ParentCrumb {...props} />
      <span class="tsk-crumb-sep" aria-hidden="true">
        ›
      </span>
      <span class="tsk-crumb-current">
        <span class="tsk-key" data-testid="task-detail-key">
          {taskKey(props.projectLabel, task())}
        </span>
        {task().title}
      </span>
      <SaveRow {...props} />
      <Show when={props.railCollapsed}>
        <IconButton
          icon="chevron-double-left"
          size="small"
          variant="ghost"
          data-icon-interaction="subdued"
          data-testid="task-detail-rail-expand"
          aria-label={t("tasks.detail.showProperties")}
          aria-expanded={false}
          aria-controls="task-detail-rail"
          onClick={() => props.onToggleRail()}
        />
      </Show>
    </nav>
  )
}

function ParentTag(props: TaskDetailProps): JSX.Element {
  const t = useTranslator(tasksDictionary)
  return (
    <Show when={props.view.parent}>
      {(parent) => (
        <button
          type="button"
          class="tsk-parent-tag"
          data-testid="task-detail-parent-tag"
          disabled={!props.onOpenParent}
          onClick={() => props.onOpenParent?.()}
        >
          {t("tasks.detail.subtaskOf")} <span class="tsk-key">{taskKey(props.projectLabel, parent())}</span>
          <span class="tsk-truncate">{parent().title}</span>
        </button>
      )}
    </Show>
  )
}

function DetailMain(props: TaskDetailProps): JSX.Element {
  const t = useTranslator(tasksDictionary)
  const patch = (input: Partial<TaskDetailEdit>) => props.onEditChange({ ...props.edit, ...input })
  return (
    <div class="tsk-detail-main">
      <Crumbs {...props} />
      <ParentTag {...props} />
      <TaskTitleField
        testId="task-detail-title"
        ariaLabel={t("tasks.detail.titleLabel")}
        placeholder={t("tasks.detail.untitled")}
        value={props.edit.title}
        onInput={(title) => patch({ title })}
      />
      <div class="tsk-prose">
        <ProseField
          value={props.edit.description}
          placeholder={t("tasks.detail.descriptionPlaceholder")}
          ariaLabel={t("tasks.detail.descriptionLabel")}
          testId="task-detail-description"
          onChange={(description) => patch({ description })}
        />
      </div>
      <Show when={props.attachments}>{(section) => section()}</Show>
      <Show when={props.conflict}>
        {(title) => (
          <p class="tsk-error" role="alert" data-testid="task-detail-conflict">
            {t("tasks.detail.conflict", { title: title() })}
          </p>
        )}
      </Show>
      <Show when={props.error}>
        {(message) => (
          <p class="tsk-error" role="alert">
            {message()}
          </p>
        )}
      </Show>
      <Show when={props.subtasks}>{(section) => section()}</Show>
    </div>
  )
}

export function TaskDetail(props: TaskDetailProps): JSX.Element {
  return (
    <article
      class="tsk tsk-detail"
      data-testid="task-detail"
      data-rail={props.railCollapsed ? "collapsed" : undefined}
      aria-label={props.view.task.title}
    >
      <DetailMain {...props} />
      <TaskRail {...props} />
    </article>
  )
}
