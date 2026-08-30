import type { AgentHarnessFactory } from "../runtime"
import { CursorHarnessAdapter } from "../harnesses/cursor"
import { harnessFactory, type NativeFactoryOptions } from "./factory"

export type CursorFactoryOptions = NativeFactoryOptions

export function cursor(options: CursorFactoryOptions = {}): AgentHarnessFactory {
  return harnessFactory("cursor", "native", (context) => new CursorHarnessAdapter({
    store: context.store,
    eventHub: context.eventHub,
    ...(options.binary ? { binary: options.binary } : {}),
    ...(options.processObserver ? { processObserver: options.processObserver } : {}),
  }))
}
