import path from "node:path"
import { realDirectoryPath } from "@claxedo/helpers/real-path"
import { inside } from "@claxedo/helpers/path"
import type { RuntimeBus } from "../bus"
import { createSessionCore, type SessionCore } from "../core"
import type { SessionPlacement } from "../placement"
import type { RuntimeEventHub } from "../projection/runtime-event-hub"

export function testSessionCore(directory = process.cwd(), workspaceId = "ws_test", eventHub?: RuntimeEventHub): SessionCore {
  return createSessionCore({ eventHub, placement: {
    workspaceId, directory: path.resolve(directory), normalizeDirectory: (directory) => path.resolve(directory.trim()), canonicalDirectory: realDirectoryPath,
    containsDirectory: inside, sessionIdWorkspace: () => undefined,
  } })
}

export function testSessionRoutePorts(bus?: RuntimeBus): { bus: RuntimeBus; placement: SessionPlacement } {
  const core = testSessionCore()
  return { bus: bus ?? core.bus, placement: core.placement }
}
