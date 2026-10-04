import type { ProviderDefinition } from "./provider-definition.js"
import { noProviderBinding, type ProviderBinding } from "./provider-binding.js"
import type { OpenCodeRuntime } from "./runtime.js"
import type { WorkspaceScope } from "./scope.js"

export async function rollbackOpenCodeSession(input: {
  runtime: OpenCodeRuntime
  scope: WorkspaceScope
  upstream?: string
  rowID?: string
  registered: boolean
  priorDefinitions?: readonly ProviderDefinition[]
  priorBinding?: ProviderBinding
  restorePlan(): Promise<void>
}): Promise<unknown[]> {
  const failures: unknown[] = []
  if (input.registered && input.rowID) {
    try { await input.runtime.tools.unregisterSession(input.rowID) } catch (cause) { failures.push(cause) }
  }
  if (input.rowID && !input.upstream) {
    try { await input.runtime.sessions.remove(input.scope, input.rowID) } catch (cause) { failures.push(cause) }
  }
  try { await input.runtime.defineProviders(input.priorDefinitions ?? []) } catch (cause) { failures.push(cause) }
  try { await input.runtime.bindProviders(input.priorBinding ?? noProviderBinding) }
  catch (cause) { failures.push(cause) }
  try { await input.restorePlan() } catch (cause) { failures.push(cause) }
  return failures
}
