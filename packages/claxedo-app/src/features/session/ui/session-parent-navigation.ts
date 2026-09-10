import { sessionRoute } from "@/platform/identity/route"

type SessionInfo = { parentID?: string }

export function createParentSessionNavigation(
  info: () => SessionInfo | undefined,
  navigate: (route: string) => unknown,
) {
  return () => {
    const parentSessionId = info()?.parentID
    if (!parentSessionId) return
    navigate(sessionRoute(parentSessionId))
  }
}
