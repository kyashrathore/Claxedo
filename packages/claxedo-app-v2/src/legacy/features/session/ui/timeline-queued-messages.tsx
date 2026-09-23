import { For, Index, Show, type Accessor } from "solid-js"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { ClaxedoIconButton as IconButton } from "@/ui/controls/claxedo-icon-button"
import { ClaxedoIcon } from "@/ui/controls/claxedo-icon"
import { useLanguage } from "@/platform/i18n/provider"
import type { QueuedMessageRecord } from "@/platform/runtime/agent/agent-runtime-client"
import { queuedMessageText, type QueuedMessagesController } from "@/features/session/queue/queued-messages-controller"

/**
 * Prompts the runtime is holding for the next turn, drawn where they will land:
 * after the last transcript row, in the user-message bubble, dimmed until the
 * runtime admits them. The `ui-user-message` classes are the transcript's own,
 * so the hover-revealed action row below the bubble behaves like a sent
 * message's copy row.
 */
export function TimelineQueuedMessages(props: {
  queued: QueuedMessagesController
  /** The controller's records minus those the transcript already shows. */
  items: Accessor<QueuedMessageRecord[]>
  centered: boolean
}) {
  const language = useLanguage()
  return (
    <Show when={props.items().length > 0 || props.queued.loadFailed()}>
      <div
        data-timeline-queued-messages
        classList={{
          "flex w-full min-w-0 flex-col gap-2 px-4 pb-10 md:px-5": true,
          "md:max-w-[var(--transcript-measure,48rem)] md:mx-auto 2xl:max-w-[var(--transcript-measure,880px)]": props.centered,
        }}
      >
        <Show when={props.queued.loadFailed()}>
          <div role="alert" class="ml-auto text-12-regular text-icon-critical-base">
            {language.t("ui.message.queued.loadFailed")}{" "}
            <button type="button" class="underline" onClick={props.queued.reload}>{language.t("ui.message.queued.retry")}</button>
          </div>
        </Show>
        {/* Indexed, not keyed: every poll returns fresh record objects, and a
            keyed list would rebuild each bubble every second under the pointer. */}
        <Index each={props.items()}>
          {(item) => <QueuedMessageBubble item={item()} queued={props.queued} />}
        </Index>
        <Show when={props.queued.error()}>
          {(message) => <div role="alert" class="ml-auto text-12-regular text-icon-critical-base">{message()}</div>}
        </Show>
      </div>
    </Show>
  )
}

function QueuedMessageBubble(props: { item: QueuedMessageRecord; queued: QueuedMessagesController }) {
  const language = useLanguage()
  const editing = () => props.queued.editing() === props.item.seq
  // Held by another client's edit: shown as editing, releasable, not editable here.
  const heldElsewhere = () => props.item.held && !editing()
  const busy = () => props.queued.pending() !== undefined || !!props.item.steering && props.item.steering.state !== "rejected"
  const status = () => props.item.steering?.state === "accepted" ? language.t("ui.message.queued.accepted")
    : props.item.steering?.state === "dispatching" ? language.t("ui.message.queued.dispatching")
    : props.item.steering?.state === "unknown" ? language.t("ui.message.queued.unknown")
    : language.t(editing() || heldElsewhere() ? "ui.message.queued.editing" : "ui.message.queued")
  const text = () => queuedMessageText(props.item)
  const attachments = () => props.item.parts.filter((part) => part.type === "file")
  const action = (input: { icon: "arrow-up" | "pencil" | "close-small"; label: string; onClick: () => void }) => (
    <Tooltip value={input.label} placement="top" gutter={4}>
      <IconButton
        icon={input.icon}
        size="small"
        variant="ghost"
        disabled={busy()}
        aria-label={input.label}
        onMouseDown={(event) => event.preventDefault()}
        onClick={input.onClick}
      />
    </Tooltip>
  )
  return (
    <div
      data-component="queued-message"
      data-queued-message={props.item.seq}
      data-editing={editing() || heldElsewhere() ? "true" : undefined}
      class="ui-user-message"
    >
      <div class="ui-user-message-body">
        <div data-slot="queued-message-text" class="ui-user-message-text opacity-60" data-editing={editing() || heldElsewhere() ? "true" : undefined}>
          {text()}
          <For each={attachments()}>
            {(part) => <span class="block text-12-regular text-text-weak">{part.filename ?? language.t("ui.message.attachment.alt")}</span>}
          </For>
        </div>
      </div>
      <div
        data-slot="queued-message-actions"
        class="ui-user-message-copy-wrapper"
        classList={{ "opacity-100! pointer-events-auto!": editing() || heldElsewhere() }}
      >
        <span class="inline-flex items-center gap-1.5 text-12-regular text-text-weak">
          <ClaxedoIcon name={editing() || heldElsewhere() ? "pencil" : "circle-dashed"} size="small" />
          {status()}
        </span>
        <Show
          when={!editing() && !heldElsewhere()}
          fallback={
            <button
              type="button"
              class="text-12-medium text-text-base hover:underline disabled:opacity-50"
              disabled={busy()}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => props.queued.cancelEdit(props.item.seq)}
            >
              {language.t("ui.message.queued.cancelEdit")}
            </button>
          }
        >
          {/* Opts out of the narrow-viewport 40px tap floor: three floored
              ghost buttons read as a toolbar, not a message's hover row. */}
          <span class="inline-flex items-center" data-claxedo-compact-touch>
            {action({ icon: "pencil", label: language.t("ui.message.queued.edit"), onClick: () => props.queued.beginEdit(props.item) })}
            {action({ icon: "arrow-up", label: language.t("ui.message.queued.sendNow"), onClick: () => props.queued.sendNow(props.item.seq) })}
            {action({ icon: "close-small", label: language.t("ui.message.queued.remove"), onClick: () => props.queued.remove(props.item.seq) })}
          </span>
        </Show>
      </div>
    </div>
  )
}
