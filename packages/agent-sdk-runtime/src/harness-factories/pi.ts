import type { AgentHarnessFactory } from "../runtime"
import { PiHarnessAdapter } from "../harnesses/pi"
import { harnessFactory, type NativeFactoryOptions } from "./factory"

export type PiFactoryOptions = NativeFactoryOptions & { agentDir?: string }

export function pi(options: PiFactoryOptions = {}): AgentHarnessFactory {
  return harnessFactory("pi", "native", (context) => new PiHarnessAdapter({
    store: context.store,
    ...(options.agentDir ? { agentDir: options.agentDir } : {}),
    eventHub: context.eventHub,
    reportOwnerFailure: context.reportOwnerFailure,
    ...(options.binary ? { binary: options.binary } : {}),
    ...(options.processObserver ? { processObserver: options.processObserver } : {}),
  }))
}
