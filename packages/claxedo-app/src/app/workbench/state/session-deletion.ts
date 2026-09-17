import type { ContentMeta } from "./types"
import { readField, readString } from "@/lib/record"

/** Remove saved session surfaces when their authoritative runtime deletes them. */
export function listenForSessionDeletion(input: {
  listen: (listener: (event: { name: string; details: { type: string; properties?: unknown } }) => void) => () => void
  surfaces: () => Array<{ id: string; type: string; sessionId?: string; directory?: string }>
  closeContent: (id: string) => void
  /**
   * A subagent's transcript is a workspace-panel tab, not a workbench surface, so
   * it is not in `surfaces` and cannot be closed by id from here.
   */
  closeSubagentTabs?: (sessionId: string) => void
}) {
  return input.listen(({ name, details }) => {
    if (details.type !== "session.deleted") return
    const info = readField(details.properties, "info")
    const sessionId = readString(info, "id")
    // The frame's address (`name`) is the workspace as this surface registered
    // it — `workspace:<id>` for a relay-backed workspace; `info.directory` is
    // the runtime's own path, which names nothing here for one.
    const directory = (name !== "global" && name) || readString(info, "directory")
    if (!sessionId || !directory || directory === "global") return
    closeDeletedSessionSurfaces({ ...input, identity: { sessionId, directory } })
  })
}

export function closeDeletedSessionSurfaces(input: {
  identity: Required<Pick<ContentMeta, "sessionId" | "directory">>
  surfaces: () => Array<{ id: string; type: string; sessionId?: string; directory?: string }>
  closeContent: (id: string) => void
  closeSubagentTabs?: (sessionId: string) => void
}) {
  input.closeSubagentTabs?.(input.identity.sessionId)
  for (const surface of input.surfaces()) {
    if ((surface.type === "session" || surface.type === "context") &&
      surface.sessionId === input.identity.sessionId && surface.directory === input.identity.directory) {
      input.closeContent(surface.id)
    }
  }
}
