import type { AgentHarnessFactory } from "../runtime"
import { isAcpConnectionId } from "../harness-types"
import { AcpHarnessAdapter } from "../harnesses/acp"
import type { ACPConnection } from "../harnesses/acp"
import { harnessFactory, type ProcessObservedFactoryOptions } from "./factory"

export type AcpFactoryOptions = ProcessObservedFactoryOptions & {
  connection: ACPConnection
  createTransport?: unknown
}

export function acp(id: string, options: AcpFactoryOptions): AgentHarnessFactory {
  if (!isAcpConnectionId(id)) throw new Error(`Invalid ACP connection id: ${id}`)
  return harnessFactory(id, "connection", (context) => new AcpHarnessAdapter({
    connection: options.connection,
    harness: id,
    store: context.store,
    eventHub: context.eventHub,
    ...(options.createTransport ? { createTransport: options.createTransport as ConstructorParameters<typeof AcpHarnessAdapter>[0]["createTransport"] } : {}),
    ...(options.processObserver ? { processObserver: options.processObserver } : {}),
  }))
}
