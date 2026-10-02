import { For, Index, Show, type Accessor } from "solid-js"
import { ClaxedoIconButton as IconButton, Tooltip } from "@/ui"
import { ClaxedoIcon as Icon } from "@/ui"
import { queuedMessageText, type QueuedMessage, type QueuedMessages, type TimelineTranslate } from "./model"
import { queuedMessageStatus } from "./queued-message-status"

export function TimelineQueuedMessages(props: {
  queued: QueuedMessages
  items: Accessor<readonly QueuedMessage[]>
  centered: boolean
  t: TimelineTranslate
}) {
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
            {props.t("ui.message.queued.loadFailed")}{" "}
            <button type="button" class="underline" onClick={props.queued.reload}>{props.t("ui.message.queued.retry")}</button>
          </div>
        </Show>
        <Index each={props.items()}>
          {(item) => <QueuedMessageBubble item={item()} queued={props.queued} t={props.t} />}
        </Index>
        <Show when={props.queued.error()}>
          {(message) => <div role="alert" class="ml-auto text-12-regular text-icon-critical-base">{message()}</div>}
        </Show>
      </div>
    </Show>
  )
}

function QueuedMessageBubble(props: { item: QueuedMessage; queued: QueuedMessages; t: TimelineTranslate }) {
  const editing = () => props.queued.editing() === props.item.seq
  const heldElsewhere = () => props.item.held && !editing()
  const busy = () => props.queued.pending() !== undefined || !!props.item.steering && props.item.steering.state !== "rejected"
  const status = () => queuedMessageStatus(props.item, editing() || heldElsewhere(), props.t)
  const text = () => queuedMessageText(props.item)
  const attachments = () => props.item.parts.filter((part) => part.type === "file")
  const action = (input: { icon: "arrow-up" | "pencil" | "close-small"; label: string; removable?: boolean; onClick: () => void }) => (
    <Tooltip value={input.label} placement="top" gutter={4}>
      <IconButton
        icon={input.icon}
        size="small"
        variant="ghost"
        disabled={input.removable ? props.queued.pending() !== undefined : busy()}
        aria-label={input.label}
        onMouseDown={(event: MouseEvent) => event.preventDefault()}
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
        <div class="ui-user-message-text opacity-60" data-editing={editing() || heldElsewhere() ? "true" : undefined}>
          {text()}
          <For each={attachments()}>
            {(part) => <span class="block text-12-regular text-text-weak">{part.filename ?? props.t("ui.message.attachment.alt")}</span>}
          </For>
        </div>
      </div>
      <div
        class="ui-user-message-copy-wrapper"
        classList={{ "opacity-100! pointer-events-auto!": editing() || heldElsewhere() }}
      >
        <Tooltip value={status().reason} inactive={!status().reason} placement="top" gutter={4}>
          <span class="inline-flex items-center gap-1.5 text-12-regular text-text-weak" data-queued-status={props.item.steering?.state}>
            <Icon name={editing() || heldElsewhere() ? "pencil" : "circle-dashed"} size="small" />
            {status().label}
          </span>
        </Tooltip>
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
              {props.t("ui.message.queued.cancelEdit")}
            </button>
          }
        >
          <span class="inline-flex items-center" data-claxedo-compact-touch>
            {action({ icon: "pencil", label: props.t("ui.message.queued.edit"), onClick: () => props.queued.beginEdit(props.item) })}
            {action({ icon: "arrow-up", label: status().send, onClick: () => props.queued.sendNow(props.item.seq) })}
            {action({ icon: "close-small", removable: props.item.steering?.state === "unknown", label: props.t("ui.message.queued.remove"), onClick: () => props.queued.remove(props.item.seq) })}
          </span>
        </Show>
      </div>
    </div>
  )
}
