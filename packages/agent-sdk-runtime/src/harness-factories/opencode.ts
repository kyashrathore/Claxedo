import type { AgentHarnessFactory } from "../runtime"
import { OpenCodeHarnessAdapter } from "../harnesses/opencode"
import { harnessFactory, type NativeFactoryOptions } from "./factory"

export type OpenCodeFactoryOptions = NativeFactoryOptions & { url?: string; headers?: HeadersInit }

export function opencode(options: OpenCodeFactoryOptions = {}): AgentHarnessFactory {
  return harnessFactory("opencode", "native", (context) => new OpenCodeHarnessAdapter(options.url, {
    eventHub: context.eventHub,
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.processObserver ? { processObserver: options.processObserver } : {}),
  }))
}
