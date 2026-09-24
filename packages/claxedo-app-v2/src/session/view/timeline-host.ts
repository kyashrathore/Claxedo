import { createMemo, type Accessor } from "solid-js"
import type { Panel } from "@/panel"
import { sessionId as toSessionId, type Server, type SessionRef, type SessionStatus } from "@/server"
import type { SessionRowView, SessionStatusView, SessionStores, SessionView } from "@/session"
import { homePath, sessionPath, type ShellRouting } from "@/shell"
import type { WorkbenchStore } from "@/workbench"
import { useTranscriptTypography, type TimelineFocus, type TimelineHost, type TimelineSessionRow, type TimelineSettings } from "./timeline"
import type { SessionScreenText } from "./text"

export type TimelineHostInput = {
  readonly view: SessionView
  readonly parent: Accessor<SessionView | undefined>
  readonly stores: SessionStores
  readonly server: Server
  readonly workbench: WorkbenchStore
  readonly routing: ShellRouting
  readonly t: SessionScreenText
  readonly panel: Pick<Panel, "show" | "sessionId">
}

const settings: TimelineSettings = {
  showReasoningSummaries: () => false,
  shellToolPartsExpanded: () => false,
  editToolPartsExpanded: () => false,
  timelineShowTurnTokens: () => false,
  showSessionProgressBar: () => true,
}

function timelineRows(rows: readonly SessionRowView[]): readonly TimelineSessionRow[] {
  return rows.map((row) => ({
    id: row.ref.sessionId,
    title: row.title,
    parentId: row.parentSessionId,
    archived: row.archivedAt !== undefined,
  }))
}

function shownStatus(status: SessionStatusView): SessionStatus {
  return status.kind === "unknown" ? { kind: "idle" } : status
}

function openLink(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer")
}

function refFor(view: SessionView, id: string): SessionRef {
  return { ...view.ref, sessionId: toSessionId(id) }
}

function openFocus(input: TimelineHostInput, focus: TimelineFocus): void {
  input.panel.show(focus.kind === "subagent" ? { ...focus, parentSessionId: input.panel.sessionId() } : focus)
}

async function findFiles(input: TimelineHostInput, query: string): Promise<readonly string[]> {
  try {
    return await input.server.queryClient.fetchQuery(input.server.queries.files.search(input.view.ref.placementId, query))
  } catch (error) {
    console.warn("Transcript file lookup failed", { query, error })
    return []
  }
}

export function createTimelineHost(input: TimelineHostInput): TimelineHost {
  const { view, server } = input
  const sessions = createMemo(() => timelineRows(input.stores.list.rows()))
  const transcriptTypography = useTranscriptTypography()
  return {
    sessionKey: () => view.ref.sessionId,
    sessionId: () => view.ref.sessionId,
    get placementPath() {
      return server.placements.byId(view.ref.placementId)?.path ?? ""
    },
    conversation: view.conversation,
    parentConversation: () => input.parent()?.conversation(),
    sessions,
    status: () => shownStatus(view.status()),
    turnSettlePending: view.turnSettlePending,
    settings,
    transcriptTypography,
    t: (key, params) => input.t(`sessionScreen.timeline.${key}`, params),
    platform: { openLink },
    openFocus: (focus) => openFocus(input, focus),
    openSessionInPane: (id) => void input.workbench.openRoute({ kind: "session", ...refFor(view, id) }),
    findFiles: (query) => findFiles(input, query),
    sessionActions: {
      rename: (id, title) => server.sessions.rename(refFor(view, id), title),
      archive: (id) => server.sessions.archive(refFor(view, id), true),
      remove: (id) => server.sessions.remove(refFor(view, id)),
    },
    navigation: {
      toSession: (id) => input.routing.navigate(sessionPath(refFor(view, id))),
      toRoot: () => input.routing.navigate(homePath),
    },
  }
}
