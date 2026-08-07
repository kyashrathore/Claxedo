import type { SessionRef } from "@/platform/identity/session-ref"

export function centralRuntimePath(path: string, sessionRef: SessionRef | undefined) {
  if (sessionRef?.host !== "central" || !path.startsWith("/session/")) return path
  return `/api/control${path}`
}
