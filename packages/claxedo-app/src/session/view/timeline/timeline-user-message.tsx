import { createMemo, For, Show } from "solid-js"
import { AgentMessageEvent, messageAuthor, Message, Part, type UserActions } from "@/transcript"
import { MessageAuthorLane } from "./message-author"

type TimelineMessage = Parameters<typeof Message>[0]["message"]
type TimelineParts = Parameters<typeof Message>[0]["parts"]

export function TimelineUserMessage(props: {
  message: Extract<TimelineMessage, { role: "user" }>
  parts: TimelineParts
  actions?: UserActions
}) {
  const agentAuthor = createMemo(() => {
    const author = messageAuthor(props.message)
    return author?.kind === "agent" ? author : undefined
  })
  return (
    <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
      <div data-slot="session-turn-message-content" aria-live="off">
        <Show when={agentAuthor()} fallback={
          <MessageAuthorLane message={props.message}>
            <Message message={props.message} parts={props.parts} actions={props.actions} />
          </MessageAuthorLane>
        }>
          {(author) => (
            <AgentMessageEvent sender={author().name}>
              <For each={props.parts}>{(part) => (
                <Show when={part.type === "text" ? part : undefined} fallback={<Part message={props.message} part={part} />}>
                  {(text) => <div>{text().text}</div>}
                </Show>
              )}</For>
            </AgentMessageEvent>
          )}
        </Show>
      </div>
    </div>
  )
}
