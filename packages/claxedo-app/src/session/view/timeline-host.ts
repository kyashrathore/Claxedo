import { createMemo, type Accessor } from "solid-js"
import type { Panel } from "@/panel"
import { sessionId as toSessionId, type Server, type SessionLocation, type SessionRow, type SessionStatus } from "@/server"
import type { SessionStatusView, SessionStores, SessionView } from "@/session"
import { usePreferences, type Preferences } from "@/settings"
import { sessionPath, type ShellRouting } from "@/shell"
import type { WorkbenchStore } from "@/workbench"
import { useTranscriptTypography, type TimelineFocus, type TimelineHost, type TimelineSessionRow, type TimelineSettings } from "./timeline"
import type { SessionScreenText } from "./text"
import { desktopBridge } from "@/lib/desktop-bridge"
import { resolveTranscriptTypography } from "@/ui/utils"
import { transcriptViewport } from "../transcript-viewport"
import { openExternal } from "@/lib/external-link"

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

export function timelineText(t: SessionScreenText): TimelineHost["t"] {
  return (key, params) => t(`sessionScreen.timeline.${key}`, params)
}

function timelineSettings(preferences: Preferences): TimelineSettings {
  return {
    showReasoningSummaries: () => preferences.transcript.showReasoningSummaries,
    shellToolPartsExpanded: () => preferences.transcript.shellToolPartsExpanded,
    editToolPartsExpanded: () => preferences.transcript.editToolPartsExpanded,
    timelineShowTurnTokens: () => false,
  }
}

function timelineRows(rows: readonly SessionRow[]): readonly TimelineSessionRow[] {
  return rows.map((row) => ({
    id: row.ref.sessionId,
    title: row.title,
    parentId: row.parentSessionId,
    archived: row.archivedAt !== undefined,
    ...(row.lastTurn ? { lastTurn: row.lastTurn } : {}),
  }))
}

function shownStatus(status: SessionStatusView): SessionStatus {
  return status.kind === "unknown" || status.kind === "runningInBackground" ? { kind: "idle" } : status
}

function refFor(view: SessionView, id: string): SessionLocation {
  return { ...view.ref, sessionId: toSessionId(id) }
}

function openFocus(input: TimelineHostInput, focus: TimelineFocus): void {
  const options = focus.kind === "file" ? undefined : { navigator: null }
  input.panel.show(focus.kind === "subagent" ? { ...focus, parentSessionId: input.panel.sessionId() } : focus, options)
}

async function findFiles(input: TimelineHostInput, query: string): Promise<readonly string[]> {
  try {
    return await input.server.queryClient.fetchQuery(input.server.queries.files.search(input.view.ref.placementId, query, "files"))
  } catch (error) {
    console.warn("Transcript file lookup failed", { query, error })
    return []
  }
}

export function createTimelineHost(input: TimelineHostInput): TimelineHost {
  const { view, server } = input
  const sessions = createMemo(() => {
    const list = input.stores.list
    return timelineRows(list.order().flatMap((ref) => list.rowOf(ref.sessionId) ?? []))
  })
  const transcriptTypography = useTranscriptTypography()
  const settings = timelineSettings(usePreferences())
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
    backgroundWork: view.backgroundWork,
    turnSettlePending: view.turnSettlePending,
    settings,
    transcriptTypography,
    t: timelineText(input.t),
    platform: { openLink: openExternal, renderMermaid: desktopBridge()?.renderMermaid },
    openFocus: (focus) => openFocus(input, focus),
    openSessionInPane: (id) => void input.workbench.openRoute({ kind: "session", ...refFor(view, id) }),
    findFiles: (query) => findFiles(input, query),
    navigation: {
      toSession: (id) => input.routing.navigate(sessionPath(refFor(view, id))),
    },
    recordViewport: (size) => input.stores.recordViewport(transcriptViewport(size, resolveTranscriptTypography(transcriptTypography()))),
  }
}
