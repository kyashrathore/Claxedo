import type { AgentHarnessFactory } from "../runtime"
import { isAcpConnectionId } from "@claxedo/agent-runtime-contract"
import { AcpHarnessAdapter } from "../harnesses/acp"
import type { ACPConnection, ACPTransportFactory } from "../harnesses/acp"
import { harnessFactory, type ProcessObservedFactoryOptions } from "./factory"

export type AcpFactoryOptions = ProcessObservedFactoryOptions & {
  connection: ACPConnection
  createTransport?: ACPTransportFactory
}

export function acp(id: string, options: AcpFactoryOptions): AgentHarnessFactory {
  if (!isAcpConnectionId(id)) throw new Error(`Invalid ACP connection id: ${id}`)
  return harnessFactory(id, "connection", (context) => new AcpHarnessAdapter({
    connection: options.connection,
    harness: id,
    store: context.store,
    eventHub: context.eventHub,
    reportOwnerFailure: context.reportOwnerFailure,
    ...(options.createTransport ? { createTransport: options.createTransport } : {}),
    ...(options.processObserver ? { processObserver: options.processObserver } : {}),
  }))
}
