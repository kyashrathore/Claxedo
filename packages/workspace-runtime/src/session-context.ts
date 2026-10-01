import { AsyncLocalStorage } from "node:async_hooks"
import type { SessionCore } from "@claxedo/session-core"

const contexts = new AsyncLocalStorage<SessionCore>()
export function withSessionCore<T>(core: SessionCore, run: () => T): T { return contexts.run(core, run) }
export function currentSessionCore(): SessionCore {
  const core = contexts.getStore()
  if (!core) throw new Error("Session core context is required")
  return core
}
