import { commandEntries, type CommandEntry } from "./catalog-port.js"
import { engineRead } from "./engine-read.js"
import type { OpenCodeHost } from "./host.js"
import type { OpenCodeInstances } from "./instances.js"
import type { WorkspaceScope } from "./scope.js"
import { ownedClient } from "./session-management.js"

export async function instanceCommands(host: OpenCodeHost, instances: OpenCodeInstances, scope: WorkspaceScope,
  sessionID: string): Promise<readonly CommandEntry[]> {
  const client = await ownedClient(host, scope, sessionID)
  await engineRead("permission.list", scope, () => client.permission.list({ sessionID }))
  return commandEntries(await engineRead("command.list", scope, () => instances.commands(sessionID)))
}
