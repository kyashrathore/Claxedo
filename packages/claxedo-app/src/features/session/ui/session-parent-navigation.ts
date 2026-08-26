import { sessionRoute } from "@/platform/identity/route"

type SessionInfo = { parentID?: string }
type SessionContent = { id: string; type: string; sessionId?: string }
type SessionNavigationState = {
  meta: { find: (predicate: (item: SessionContent) => boolean) => SessionContent | undefined }
  layout: { restoreContentFocus: (contentId: string) => void }
}

export function createParentSessionNavigation(
  info: () => SessionInfo | undefined,
  sessionId: () => string | undefined,
  state: SessionNavigationState,
  navigate: (route: string) => unknown,
) {
  return () => {
    const parentSessionId = info()?.parentID
    if (!parentSessionId) return
    const childSessionId = sessionId()
    const content = childSessionId
      ? state.meta.find((item) => item.type === "session" && item.sessionId === childSessionId)
      : undefined
    navigate(sessionRoute(parentSessionId))
    if (content) state.layout.restoreContentFocus(content.id)
  }
}
