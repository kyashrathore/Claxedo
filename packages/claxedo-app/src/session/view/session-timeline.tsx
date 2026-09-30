import { createMemo, Show } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { usePhone } from "@/lib/viewport"
import { sessionId, useServer } from "@/server"
import type { SessionView } from "@/session"
import { sessionLinkPath } from "@/shell"
import { DataProvider, TranscriptKitProviders, type SubagentStopAnswer, type TranscriptUserMessage } from "@/transcript"
import { MessageTimeline, type SessionErrorClass, type TimelineHost, type TimelineNavTurn } from "./timeline"
import type { TimelineScroll } from "./timeline-scroll"
import { subagentViews } from "./subagent-views"
import { useSessionScreenText } from "./text"
import "./transcript-kit.css"


export function userMessages(view: SessionView): TranscriptUserMessage[] {
  const messages = view.conversation()?.messages ?? []
  return messages.filter((message): message is TranscriptUserMessage => message.role === "user")
}

export function SessionTimeline(props: {
  readonly view: SessionView
  readonly navTurns: TimelineNavTurn[]
  readonly host: TimelineHost
  readonly active: boolean
  readonly onScreen: boolean
  readonly scroll: TimelineScroll
  readonly onRecover: (kind: SessionErrorClass, userMessageId: string) => unknown
}) {
  const phone = usePhone()
  const server = useServer()
  const users = createMemo(() => userMessages(props.view))
  const current = () => props.navTurns.find((turn) => turn.id === props.scroll.selected())
  const t = useSessionScreenText()
  const labels = { subagent: t("sessionScreen.subagent.label"), task: t("sessionScreen.subagent.task") }
  const backgroundRunning = createMemo(() => props.view.subagents().some((entry) => entry.mode === "background" && (entry.status === "running" || entry.status === "pending")))
  const stops = useQuery(() => ({ ...server.queries.harnesses.stopsBackgroundTasks(props.view.ref), enabled: backgroundRunning() }))
  const resolveSubagents = (parentSessionId: string, toolCallId?: string) =>
    parentSessionId === props.view.ref.sessionId
      ? subagentViews({ entries: props.view.subagents(), parentSessionId, labels, toolCallId, stops: stops.data === true })
      : []
  const stopBackgroundTask = async (parentSessionId: string, call: string): Promise<SubagentStopAnswer> => {
    const answer = await server.sessions.stopBackgroundTask({ ...props.view.ref, sessionId: sessionId(parentSessionId) }, call)
    return answer.ok ? answer : { ok: false, message: answer.message }
  }
  return (
    <TranscriptKitProviders>
      <DataProvider
        directory={props.host.placementPath}
        onNavigateToSession={props.host.navigation.toSession}
        onSessionHref={(id) =>
          sessionLinkPath({ placementId: props.view.ref.placementId, sessionId: sessionId(id) }, server.placements.byId(props.view.ref.placementId), server.capabilities()?.thisMachine?.id)
        }
        resolveSubagents={resolveSubagents}
        loadToolBody={(part) => void props.view.loadPart(part.messageID, part.id)}
        stopBackgroundTask={stopBackgroundTask}
      >
        <Show when={props.view.conversation()}>
          <MessageTimeline
            {...props.scroll.props}
            host={props.host}
            active={() => props.active}
            onScreen={() => props.onScreen}
            centered={!phone()}
            historyShift={false}
            userMessages={users()}
            navMessages={props.navTurns}
            currentMessage={current()}
            anchor={(id) => `message-${id}`}
            title={() => props.view.row()?.title}
            parentId={props.view.row()?.parentSessionId}
            onFirstTurnRecovery={props.onRecover}
            queued={props.view.queue}
            progressBlocked={() => !!props.view.requestsError()}
          />
        </Show>
      </DataProvider>
    </TranscriptKitProviders>
  )
}
