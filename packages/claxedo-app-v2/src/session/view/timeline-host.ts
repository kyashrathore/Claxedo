import { filePaneKind } from "@/files"
import { sessionId as toSessionId, type Server, type SessionRef, type SessionStatus } from "@/server"
import type { SessionRowView, SessionStatusView, SessionStores, SessionView } from "@/session"
import { homePath, sessionPath, type ShellRouting } from "@/shell"
import type { WorkbenchStore } from "@/workbench"
import type { TimelineFocus, TimelineHost, TimelineSessionRow, TimelineSettings } from "./timeline"
import type { SessionScreenText } from "./text"

export type TimelineHostInput = {
  readonly view: SessionView
  readonly stores: SessionStores
  readonly server: Server
  readonly workbench: WorkbenchStore
  readonly routing: ShellRouting
  readonly t: SessionScreenText
  readonly openPlan: (focus: Extract<TimelineFocus, { kind: "plan" }>) => void
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
  const ref = input.view.ref
  if (focus.kind === "file") {
    input.workbench.open(filePaneKind, { placementId: ref.placementId, path: focus.path, line: focus.line, col: focus.col })
    return
  }
  if (focus.kind === "subagent") {
    input.workbench.openRoute({ kind: "session", ...refFor(input.view, focus.sessionId) })
    return
  }
  if (focus.kind === "browser") return openLink(focus.url)
  input.openPlan(focus)
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
  const parent = () => view.row()?.parentSessionId
  return {
    sessionKey: () => view.ref.sessionId,
    sessionId: () => view.ref.sessionId,
    get placementPath() {
      return server.placements.byId(view.ref.placementId)?.path ?? ""
    },
    conversation: view.conversation,
    parentConversation: () => {
      const id = parent()
      return id ? input.stores.open(refFor(view, id)).conversation() : undefined
    },
    sessions: () => timelineRows(input.stores.list.rows()),
    status: () => shownStatus(view.status()),
    turnSettlePending: view.turnSettlePending,
    settings,
    transcriptTypography: () => ({ pairing: "default" }),
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
