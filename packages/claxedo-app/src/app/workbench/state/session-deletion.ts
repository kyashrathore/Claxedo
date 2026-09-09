import type { ContentMeta } from "./types"
import { readField, readString } from "@/lib/record"

/** Remove saved session surfaces when their authoritative runtime deletes them. */
export function listenForSessionDeletion(input: {
  listen: (listener: (event: { name: string; details: { type: string; properties?: unknown } }) => void) => () => void
  surfaces: () => Array<{ id: string; type: string; sessionId?: string; directory?: string }>
  closeContent: (id: string) => void
}) {
  return input.listen(({ name, details }) => {
    if (details.type !== "session.deleted") return
    const info = readField(details.properties, "info")
    const sessionId = readString(info, "id")
    const directory = readString(info, "directory") || name
    if (!sessionId || !directory || directory === "global") return
    closeDeletedSessionSurfaces({ ...input, identity: { sessionId, directory } })
  })
}

export function closeDeletedSessionSurfaces(input: {
  identity: Required<Pick<ContentMeta, "sessionId" | "directory">>
  surfaces: () => Array<{ id: string; type: string; sessionId?: string; directory?: string }>
  closeContent: (id: string) => void
}) {
  for (const surface of input.surfaces()) {
    if ((surface.type === "session" || surface.type === "context") &&
      surface.sessionId === input.identity.sessionId && surface.directory === input.identity.directory) {
      input.closeContent(surface.id)
    }
  }
}
