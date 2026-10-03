import type { SessionLocation } from "@/server"

export const sameSessionLocation = (a: SessionLocation, b: SessionLocation): boolean => a.sessionId === b.sessionId && a.placementId === b.placementId && a.projectId === b.projectId
