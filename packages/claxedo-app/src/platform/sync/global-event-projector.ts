import { Binary } from "@/lib/binary"
import type { Project } from "@opencode-ai/sdk/v2/client"

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
  // The embedded OpenCode engine emits `project.updated` for the same worktree
  // the control plane already owns, but under its own hashed project id. That
  // never matches on id, so it used to be inserted as a *second* project for
  // one worktree — and because it carries no `name` and no `workspaces`, any
  // consumer keying by worktree (the rail's project catalog does) could pick it
  // and render the worktree basename with no sessions. The control-plane entry
  // is authoritative for a worktree; the engine's payload adds nothing to it.
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
