import type { VirtualItem } from "@tanstack/solid-virtual"
import type { TimelineScrollPosition } from "./timeline-scroll-memory"

export type TimelineMountSnapshot = {
  scroll?: TimelineScrollPosition
  measurements: VirtualItem[]
  toolOpen: Record<string, boolean | undefined>
  groupOpen: Record<string, boolean | undefined>
  toolRevealed: Record<string, boolean | undefined>
}

const snapshots = new Map<string, TimelineMountSnapshot>()
const MAX_SESSIONS = 64

export function readTimelineMountSnapshot(sessionKey: string): TimelineMountSnapshot | undefined {
  return snapshots.get(sessionKey)
}

export function writeTimelineMountSnapshot(sessionKey: string, snapshot: TimelineMountSnapshot) {
  snapshots.delete(sessionKey)
  snapshots.set(sessionKey, snapshot)
  while (snapshots.size > MAX_SESSIONS) snapshots.delete(snapshots.keys().next().value!)
}
