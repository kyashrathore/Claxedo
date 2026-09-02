import type { AgentHarnessFactory } from "../runtime"
import type { RuntimeEventHub } from "../runtime-event-hub"
import type { AgentHarnessAccess, SessionHarnessId } from "../harness-types"
import type { AgentRuntimeStoreWithRecovery } from "../harnesses/shared/runtime-store"
import type { AgentProcessObserver } from "../process-observer"

export type ProcessObservedFactoryOptions = { processObserver?: AgentProcessObserver }
export type NativeFactoryOptions = ProcessObservedFactoryOptions & { access?: "native"; binary?: string }
export type AgentHarnessFactoryContext = { store: AgentRuntimeStoreWithRecovery; eventHub: RuntimeEventHub }

export function harnessFactory(
  id: SessionHarnessId,
  access: AgentHarnessAccess,
  create: (context: AgentHarnessFactoryContext) => unknown,
): AgentHarnessFactory {
  return { id, access, create } as unknown as AgentHarnessFactory
}
