import { createMemo, Show } from "solid-js"
import { usePhone } from "@/lib/viewport"
import { sessionId } from "@/server"
import type { SessionView } from "@/session"
import { sessionPath } from "@/shell"
import { DataProvider, type TranscriptUserMessage } from "@/transcript"
import { MessageTimeline, turnActive, type TimelineHost } from "./timeline"
import { createTimelineScroll } from "./timeline-scroll"
import { TranscriptKitProviders } from "./transcript-kit"

const EMPTY_DATA = { session: [], session_status: {}, session_diff: {}, message: {}, part: {} }

function userMessages(view: SessionView): TranscriptUserMessage[] {
  const messages = view.conversation()?.messages ?? []
  return messages.filter((message): message is TranscriptUserMessage => message.role === "user")
}

export function SessionTimeline(props: {
  readonly view: SessionView
  readonly host: TimelineHost
  readonly active: boolean
  readonly onNavigateParent: () => void
}) {
  const phone = usePhone()
  const users = createMemo(() => userMessages(props.view))
  const working = () => {
    const status = props.view.status()
    return status.kind !== "unknown" && turnActive(status)
  }
  const scroll = createTimelineScroll({ view: () => props.view, active: () => props.active, working })
  const current = () => users().find((message) => message.id === scroll.selected())
  return (
    <TranscriptKitProviders>
      <DataProvider
        data={EMPTY_DATA}
        directory={props.host.placementPath}
        onNavigateToSession={props.host.navigation.toSession}
        onSessionHref={(id) => sessionPath({ placementId: props.view.ref.placementId, sessionId: sessionId(id) })}
      >
        <Show when={props.view.conversation()}>
          <MessageTimeline
            {...scroll.props}
            host={props.host}
            active={() => props.active}
            centered={!phone()}
            historyShift={false}
            userMessages={users()}
            navMessages={users()}
            currentMessage={current()}
            anchor={(id) => `message-${id}`}
            title={() => props.view.row()?.title}
            parentId={props.view.row()?.parentSessionId}
            onNavigateParent={props.onNavigateParent}
            queued={props.view.queue}
          />
        </Show>
      </DataProvider>
    </TranscriptKitProviders>
  )
}
