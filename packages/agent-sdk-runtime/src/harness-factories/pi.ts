import type { AgentHarnessFactory } from "../runtime"
import type { SessionEnvFactory, SessionEnvFactoryInput } from "../session-env"
import { PiHarnessAdapter } from "../harnesses/pi"
import { harnessFactory, type ProcessObservedFactoryOptions } from "./factory"

export type PiSessionPlacement = Omit<SessionEnvFactoryInput, "sessionId">
export type PiFactoryOptions = ProcessObservedFactoryOptions & {
  access?: "native"
  createEnv?: SessionEnvFactory
  defaultPlacement?: PiSessionPlacement | ((input: {
    sessionId: string
    directory: string | undefined
  }) => PiSessionPlacement | Promise<PiSessionPlacement>)
}

export function pi(options: PiFactoryOptions = {}): AgentHarnessFactory {
  return harnessFactory("pi", "native", (context) => new PiHarnessAdapter({
    ...options,
    eventHub: context.eventHub,
    goalStore: context.store,
  }))
}
