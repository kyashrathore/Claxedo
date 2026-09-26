import type { StartInput } from "../../contract"
import { providerOverlays } from "./credentials.js"
import type { OpenCodeRuntime } from "./runtime.js"
import type { WorkspaceScope } from "./scope.js"
import type { OpenCodeLaunchDocument } from "./launch-policy.js"

export async function rollbackOpenCodeSession(input: {
  runtime: OpenCodeRuntime
  scope: WorkspaceScope
  upstream?: string
  rowID?: string
  registered: boolean
  document: OpenCodeLaunchDocument
  binding?: StartInput["credentials"]
}): Promise<unknown[]> {
  const failures: unknown[] = []
  if (input.registered && input.rowID) {
    try { await input.runtime.tools.unregisterSession(input.rowID) } catch (cause) { failures.push(cause) }
  }
  if (input.rowID && !input.upstream) {
    try { await input.runtime.sessions.remove(input.scope, input.rowID) } catch (cause) { failures.push(cause) }
  }
  try { await (await input.runtime.launch(input.scope)).write(input.document) } catch (cause) { failures.push(cause) }
  try { await input.runtime.bindProviders(input.binding ? providerOverlays(input.binding) : {}) }
  catch (cause) { failures.push(cause) }
  return failures
}
