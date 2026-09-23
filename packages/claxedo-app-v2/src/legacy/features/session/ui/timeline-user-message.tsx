import { Message, type UserActions } from "@/ui/session-kit"
import { MessageAuthorLane } from "./message-author"

type TimelineMessage = Parameters<typeof Message>[0]["message"]
type TimelineParts = Parameters<typeof Message>[0]["parts"]

export function TimelineUserMessage(props: {
  message: Extract<TimelineMessage, { role: "user" }>
  parts: TimelineParts
  actions?: UserActions
}) {
  return (
    <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
      <div data-slot="session-turn-message-content" aria-live="off">
        <MessageAuthorLane message={props.message}>
          <Message message={props.message} parts={props.parts} actions={props.actions} />
        </MessageAuthorLane>
      </div>
    </div>
  )
}
