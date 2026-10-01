import { AsyncLocalStorage } from "node:async_hooks"
import type { SessionCore } from "@claxedo/session-core"

// Each public dist entry (index/host/routes/testing…) is bundled separately,
// so this module is instantiated once per entry in the same process. The
// storage is pinned on globalThis so a host built from one entry and a PTY or
// route from another read the same context; each context still holds only
// the core its own request or callback entered.
const contextsKey = Symbol.for("claxedo.workspace-runtime.session-core-context")
const pinned = globalThis as Record<PropertyKey, unknown>
const contexts: AsyncLocalStorage<SessionCore> = pinned[contextsKey] instanceof AsyncLocalStorage
  ? pinned[contextsKey] as AsyncLocalStorage<SessionCore>
  : (pinned[contextsKey] = new AsyncLocalStorage<SessionCore>())

export function withSessionCore<T>(core: SessionCore, run: () => T): T { return contexts.run(core, run) }
export function currentSessionCore(): SessionCore {
  const core = contexts.getStore()
  if (!core) throw new Error("Session core context is required")
  return core
}
