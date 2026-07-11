import { Binary } from "@/utils/binary"
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
