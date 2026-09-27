import { createEffect, on, onCleanup, type Accessor } from "solid-js"
import type { Commands } from "@/shell"
import type { SessionScreenText } from "./text"
import type { TimelineNavTurn } from "./timeline"
import type { TimelineScroll } from "./timeline-scroll"

const MESSAGE_HASH = /^#message-(.+)$/

type MessageLinksInput = {
  readonly turns: Accessor<TimelineNavTurn[]>
  readonly scroll: TimelineScroll
  readonly active: Accessor<boolean>
  readonly commands: Commands
  readonly t: SessionScreenText
}

type Seek = (turn: TimelineNavTurn | undefined) => void

function followMessageHash(input: MessageLinksInput, seek: Seek) {
  const followHash = () => {
    const raw = MESSAGE_HASH.exec(location.hash)?.[1]
    if (raw) seek({ id: decodeURIComponent(raw) })
  }
  createEffect(on(() => input.turns().length > 0, (ready) => ready && followHash()))
  window.addEventListener("hashchange", followHash)
  onCleanup(() => window.removeEventListener("hashchange", followHash))
}

function registerMessageSteps(input: MessageLinksInput, seek: Seek) {
  const byOffset = (offset: -1 | 1) => {
    const list = input.turns()
    if (list.length === 0) return
    const index = list.findIndex((turn) => turn.id === input.scroll.selected())
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
  const seek: Seek = (turn) => {
    if (turn) input.scroll.props.onMessageSelect?.(turn)
  }
  followMessageHash(input, seek)
  registerMessageSteps(input, seek)
}
