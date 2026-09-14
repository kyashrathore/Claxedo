import type { AgentHarnessFactory } from "../runtime"
import type { AgentHarnessFactoryContext } from "../runtime/contracts"
import type { AgentHarnessAccess, SessionHarnessId } from "@claxedo/agent-runtime-contract"
import type { AgentHarnessAdapter } from "../adapter-contract"
import type { AgentProcessObserver } from "../process-observer"

export type ProcessObservedFactoryOptions = { processObserver?: AgentProcessObserver }
export type NativeFactoryOptions = ProcessObservedFactoryOptions & { access?: "native"; binary?: string }

export function harnessFactory(
  id: SessionHarnessId,
  access: AgentHarnessAccess,
  create: (context: AgentHarnessFactoryContext) => AgentHarnessAdapter,
): AgentHarnessFactory {
  return { id, access, create }
}
