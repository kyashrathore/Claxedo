import { requireAgentExecutionBinding, type AgentExecutionBinding } from "@claxedo/agent-runtime-contract"
import type { SessionTitleRequest } from "../../title-generation"
import type { AgentRuntimeStoreCore } from "./runtime-store"
import type { SdkRuntimeDriver } from "./sdk-runtime-driver"
import { Log } from "../../log"

const log = Log.create({ service: "sdk-runtime-title" })

export type { SessionTitleRequest }

type TitleStore = Pick<AgentRuntimeStoreCore, "getAgentSessionId">

/** The driver's side turn for a title, or null on a driver that titles through its stream. */
export async function generateDriverTitle(driver: SdkRuntimeDriver, store: TitleStore, binding: AgentExecutionBinding, request: SessionTitleRequest) {
  requireAgentExecutionBinding(binding)
  if (!driver.generateTitle) return null
  const agentSessionId = store.getAgentSessionId(binding.sessionId)
  if (!agentSessionId) return null
  return await driver.generateTitle({ sessionId: binding.sessionId, agentSessionId, request })
}

/**
 * Record an accepted title on the harness's own session, where the driver has
 * a rename. The Claxedo store stays authoritative: a harness that cannot take
 * the name right now (process gone, protocol error) must not fail the rename.
 */
export async function pushDriverTitle(driver: SdkRuntimeDriver, store: TitleStore, binding: AgentExecutionBinding, title: string) {
  const agentSessionId = store.getAgentSessionId(binding.sessionId)
  if (!agentSessionId || !driver.setAgentSessionTitle) return
  try {
    await driver.setAgentSessionTitle({ sessionId: binding.sessionId, agentSessionId, directory: binding.directory, title })
  } catch (error) {
    log.warn("Harness rejected the session title", { harness: driver.type, sessionId: binding.sessionId, error: error instanceof Error ? error.message : String(error) })
  }
}
