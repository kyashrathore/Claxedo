import type { AgentHarnessFactory } from "../runtime"
import { CodexHarnessAdapter } from "../harnesses/codex"
import { harnessFactory, type NativeFactoryOptions } from "./factory"

export type CodexFactoryOptions = NativeFactoryOptions

export function codex(options: CodexFactoryOptions = {}): AgentHarnessFactory {
  return harnessFactory("codex", "native", (context) => new CodexHarnessAdapter({
    store: context.store,
    eventHub: context.eventHub,
    ...(options.binary ? { binary: options.binary } : {}),
    ...(options.processObserver ? { processObserver: options.processObserver } : {}),
  }))
}
