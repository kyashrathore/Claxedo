import { provisionedRunner, snapshotDefaultHarness } from "@claxedo/server-core/agent-config/connections"
import type { UserAgentConfigRepository } from "@claxedo/server-core/agent-config/repository"

/**
 * The harness a session created with none named runs: the one the person's
 * cloud runtimes are configured to default to, as the runtime resolves it.
 * A connection's sessions are placed by their access, not by a harness id.
 */
export function defaultSessionHarnessId(repository: UserAgentConfigRepository, env: Record<string, string | undefined>) {
  return async (userId: string): Promise<string | undefined> => {
    const selected = snapshotDefaultHarness(await repository.read(userId), provisionedRunner(env))
    return selected?.kind === "native" ? selected.harnessId : selected?.kind
  }
}
