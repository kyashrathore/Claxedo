import path from "node:path"
import { realDirectoryPath } from "@claxedo/helpers/real-path"
import { inside } from "@claxedo/helpers/path"
import { createSessionCore, type RuntimeBus, type RuntimeEventHub, type SessionCore, type SessionPlacement } from "@claxedo/session-core"

export function testSessionCore(directory = process.cwd(), workspaceId = "ws_test", eventHub?: RuntimeEventHub): SessionCore {
  return createSessionCore({ eventHub, placement: {
    workspaceId, directory: path.resolve(directory), normalizeDirectory: (directory) => path.resolve(directory.trim()), canonicalDirectory: realDirectoryPath,
    containsDirectory: inside, sessionIdWorkspace: () => undefined,
  } })
}

export function testSessionRoutePorts(bus?: RuntimeBus): { bus: RuntimeBus; placement: SessionPlacement; sessionIdWorkspace: SessionPlacement["sessionIdWorkspace"] } {
  const core = testSessionCore()
  return { bus: bus ?? core.bus, placement: core.placement, sessionIdWorkspace: core.placement.sessionIdWorkspace }
}
