import type { AgentHarnessFactory } from "../runtime"
import { ClaudeHarnessAdapter } from "../harnesses/claude"
import { harnessFactory, type NativeFactoryOptions } from "./factory"

export type ClaudeFactoryOptions = NativeFactoryOptions

export function claude(options: ClaudeFactoryOptions = {}): AgentHarnessFactory {
  return harnessFactory("claude", "native", (context) => new ClaudeHarnessAdapter({
    store: context.store,
    eventHub: context.eventHub,
    ...(options.binary ? { binary: options.binary } : {}),
    ...(options.processObserver ? { processObserver: options.processObserver } : {}),
  }))
}
