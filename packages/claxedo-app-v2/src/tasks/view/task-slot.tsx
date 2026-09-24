import { For, Show, type JSX } from "solid-js"
import type { ConfigurationSlot, SessionReference, Task, TaskSessionLinkView } from "@claxedo/tasks"
import { useTranslator } from "@/i18n"
import { Button, Tag } from "@/ui"
import type { TaskStartOffer } from "../data/start"
import { dictionary } from "../i18n"
import { SLOT_KEYS, slotAttempt, type TaskLinkGroup } from "../model"
import { TaskStartControl } from "./task-row-controls"

export type SlotRowProps = {
  readonly slot: ConfigurationSlot
  readonly task: Task
  readonly group: TaskLinkGroup | undefined
  readonly offer: TaskStartOffer
  readonly busy?: boolean
  readonly onOpenSession: (sessionRef: SessionReference) => void
  readonly onSendTask: (link: TaskSessionLinkView) => void
}

function Attempts(props: {
  readonly slot: ConfigurationSlot
  readonly history: readonly TaskSessionLinkView[]
  readonly onOpenSession: (ref: SessionReference) => void
}): JSX.Element {
  const t = useTranslator(dictionary)
  return (
    <Show when={props.history.length > 0} fallback={<p class="tsk-hint">{t("tasks.slot.noSession")}</p>}>
      <ul class="tsk-attempts">
        <For each={props.history}>
          {(link) => (
            <li class="tsk-attempt" data-testid={`task-slot-attempt-${props.slot}-${link.attempt}`}>
              <span class="tsk-attempt-no">#{link.attempt}</span>
              <span class="tsk-truncate">{link.presetNameAtStart}</span>
              <Show when={link.continuedFrom}>
                <Tag>{t("tasks.slot.continued")}</Tag>
              </Show>
              <span class="tsk-spacer" />
              <span class="tsk-attempt-liveness" data-testid={`task-slot-liveness-${props.slot}-${link.attempt}`}>
                {link.liveness}
              </span>
              <Show when={link.liveness !== "deleted"}>
                <button
                  type="button"
                  class="tsk-attempt-open"
                  data-testid={`task-slot-open-attempt-${props.slot}-${link.attempt}`}
                  onClick={() => props.onOpenSession(link.sessionRef)}
                >
                  {t("tasks.start.open")}
                </button>
              </Show>
            </li>
          )}
        </For>
      </ul>
    </Show>
  )
}

export function SlotRow(props: SlotRowProps): JSX.Element {
  const t = useTranslator(dictionary)
  const next = () => slotAttempt(props.group ? [props.group] : [], props.slot)
  const current = () => next().current
  const unsent = () => {
    const link = next().open
    return link?.handoff === "pending" ? link : undefined
  }
  const notice = () => {
    if (unsent()) return t("tasks.slot.notSent")
    return next().open?.handoff === "unknown" ? t("tasks.slot.deliveryUnknown") : undefined
  }
  return (
    <div class="tsk-slot" data-testid={`task-slot-${props.slot}`}>
      <div class="tsk-slot-head">
        <span class="tsk-dot" data-liveness={current()?.liveness ?? "none"} aria-hidden="true" />
        <span class="tsk-slot-name">{t(SLOT_KEYS[props.slot])}</span>
        <span class="tsk-spacer" />
        <Show
          when={current()?.liveness === "live"}
          fallback={<TaskStartControl task={props.task} offer={props.offer} testIdPrefix={`task-slot-${props.slot}`} />}
        >
          <Button
            size="small"
            variant="ghost"
            data-testid={`task-slot-open-${props.slot}`}
            onClick={() => {
              const link = current()
              if (link) props.onOpenSession(link.sessionRef)
            }}
          >
            {t("tasks.slot.openSession")}
          </Button>
        </Show>
      </div>
      <Show when={notice()}>
        {(text) => (
          <p class="tsk-slot-notice" data-testid={`task-slot-handoff-${props.slot}`}>
            {text()}
          </p>
        )}
      </Show>
      <Show when={unsent()}>
        {(link) => (
          <Button
            size="small"
            variant="ghost"
            class="tsk-slot-resend"
            data-testid={`task-slot-send-${props.slot}`}
            disabled={props.busy || props.task.archivedAt !== null}
            onClick={() => props.onSendTask(link())}
          >
            {t("tasks.slot.send")}
          </Button>
        )}
      </Show>
      <Attempts slot={props.slot} history={props.group?.attempts ?? []} onOpenSession={props.onOpenSession} />
    </div>
  )
}
