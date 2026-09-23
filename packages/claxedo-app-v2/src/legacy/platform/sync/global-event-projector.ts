import { Binary } from "@opencode-ai/ui/utils/binary"
import type { ClaxedoProject as Project } from "@/platform/api/claxedo-api-types"
import { asRecord, readString } from "@/lib/record"

type GlobalEvent = {
  type: string
  properties?: unknown
}

/**
 * A `project.updated` payload: a PATCH, not a whole project.
 *
 * The wire payload does not carry every field `ClaxedoProject` declares — the
 * embedded engine sends `{ id, worktree, vcs }` with no `name` and no
 * `workspaces` — so this projector merges what arrived over the row it already
 * holds instead of replacing it. `id` and `worktree` are the two fields it
 * routes on: the id keys the sorted array, the worktree decides whether an
 * update is really a duplicate of a row the control plane owns. A payload
 * missing either is not routable and is dropped.
 */
type ProjectUpdate = Partial<Project> & Pick<Project, "id" | "worktree">

/**
 * Guards the two fields this projector routes on, and passes the payload
 * through untouched. Rebuilding it from the fields `ClaxedoProject` declares
 * would drop whatever a newer server sends, which is the opposite of what a
 * patch is for — so the remaining fields are typed as the DTO declares them and
 * checked by whoever reads them.
 */
function isProjectUpdate(value: unknown): value is ProjectUpdate {
  const patch = asRecord(value)
  return !!readString(patch, "id") && !!readString(patch, "worktree")
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
  const properties = input.event.properties
  if (!isProjectUpdate(properties)) return
  const result = Binary.search(input.project, properties.id, (item) => item.id)
  // Workspace and control-plane streams can report the same worktree under
  // different project ids. Keep the existing authoritative worktree row rather
  // than inserting a duplicate that cannot own the rail's session inventory.
  if (!result.found && input.project.some((item) => item.worktree === properties.worktree)) return
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
