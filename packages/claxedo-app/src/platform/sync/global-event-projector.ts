import { Binary } from "@/lib/binary"
import type { ClaxedoProject as Project } from "@/platform/api/claxedo-api-types"

type GlobalEvent = {
  type: string
  properties?: unknown
}

export function applyGlobalProjectEvent(input: {
  event: GlobalEvent
  project: Project[]
  refresh: () => void
  setGlobalProject: (next: Project[] | ((project: Project[]) => Project[])) => void
}) {
  if (input.event.type === "global.disposed" || input.event.type === "server.connected") {
    input.refresh()
    return
  }

  if (input.event.type !== "project.updated") return
  const properties = input.event.properties as Project
  const result = Binary.search(input.project, properties.id, (item) => item.id)
  // Workspace and control-plane streams can report the same worktree under
  // different project ids. Keep the existing authoritative worktree row rather
  // than inserting a duplicate that cannot own the rail's session inventory.
  if (
    !result.found &&
    !!properties.worktree &&
    input.project.some((item) => item.worktree === properties.worktree)
  ) return
  input.setGlobalProject((project) => {
    const next = [...project]
    if (result.found) {
      next[result.index] = { ...next[result.index], ...properties }
      return next
    }
    next.splice(result.index, 0, properties)
    return next
  })
}
