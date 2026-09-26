import { createEffect, on, onCleanup, type Accessor } from "solid-js"
import type { SessionView } from "@/session"
import type { Commands } from "@/shell"
import type { TranscriptUserMessage } from "@/transcript"
import type { SessionScreenText } from "./text"
import type { TimelineScroll } from "./timeline-scroll"

const MESSAGE_HASH = /^#message-(.+)$/

type MessageLinksInput = {
  readonly view: Accessor<SessionView>
  readonly users: Accessor<TranscriptUserMessage[]>
  readonly scroll: TimelineScroll
  readonly active: Accessor<boolean>
  readonly commands: Commands
  readonly t: SessionScreenText
}

type Seek = (message: TranscriptUserMessage | undefined) => void

function followMessageHash(input: MessageLinksInput, seek: Seek) {
  const seekHash = async () => {
    const raw = MESSAGE_HASH.exec(location.hash)?.[1]
    if (!raw) return
    const id = decodeURIComponent(raw)
    for (;;) {
      const message = input.users().find((candidate) => candidate.id === id)
      if (message) return seek(message)
      if (!input.view().hasOlder()) return
      await input.view().loadOlder()
      if (input.view().olderState().kind === "failed") return
    }
  }
  const followHash = () => void seekHash().catch((error: unknown) => console.error("The linked message could not be opened", error))
  createEffect(on(() => input.users().length > 0, (ready) => ready && followHash()))
  window.addEventListener("hashchange", followHash)
  onCleanup(() => window.removeEventListener("hashchange", followHash))
}

function registerMessageSteps(input: MessageLinksInput, seek: Seek) {
  const byOffset = (offset: -1 | 1) => {
    const list = input.users()
    if (list.length === 0) return
    const index = list.findIndex((message) => message.id === input.scroll.selected())
    const from = index >= 0 ? index : list.length
    seek(list[Math.max(0, Math.min(list.length - 1, from + offset))])
  }
  input.commands.register(
    "session.messages",
    () => [
      {
        id: "message.previous",
        title: input.t("command.message.previous"),
        description: input.t("command.message.previous.description"),
        keybind: "mod+arrowup",
        onSelect: () => byOffset(-1),
      },
      {
        id: "message.next",
        title: input.t("command.message.next"),
        description: input.t("command.message.next.description"),
        keybind: "mod+arrowdown",
        onSelect: () => byOffset(1),
      },
    ],
    { owner: { isVisible: input.active, isFocused: input.active } },
  )
}

export function createMessageLinks(input: MessageLinksInput) {
  const seek: Seek = (message) => {
    if (message) input.scroll.props.onMessageSelect?.(message)
  }
  followMessageHash(input, seek)
  registerMessageSteps(input, seek)
}
