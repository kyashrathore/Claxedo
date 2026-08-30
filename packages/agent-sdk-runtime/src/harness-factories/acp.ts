import type { AgentHarnessFactory } from "../runtime"
import { isAcpConnectionId } from "../harness-types"
import { AcpHarnessAdapter } from "../harnesses/acp"
import { harnessFactory, type ProcessObservedFactoryOptions } from "./factory"

export type AcpFactoryOptions = ProcessObservedFactoryOptions & {
  binary: string
  args?: string[]
  env?: Record<string, string | undefined>
  createTransport?: unknown
}

export function acp(id: string, options: AcpFactoryOptions): AgentHarnessFactory {
  if (!isAcpConnectionId(id)) throw new Error(`Invalid ACP connection id: ${id}`)
  return harnessFactory(id, "acp", (context) => new AcpHarnessAdapter({
    binary: options.binary,
    harness: id,
    store: context.store,
    eventHub: context.eventHub,
    ...(options.args ? { args: options.args } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.createTransport ? { createTransport: options.createTransport as ConstructorParameters<typeof AcpHarnessAdapter>[0]["createTransport"] } : {}),
    ...(options.processObserver ? { processObserver: options.processObserver } : {}),
  }))
}
