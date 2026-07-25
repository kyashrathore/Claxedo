import type { AgentRuntimeStore } from "../runtime"
import type { AgentRuntimeStoreWithRecovery } from "../harnesses/shared/runtime-store"

/**
 * The opaque runtime-store handle viewed as the row-level API it really is.
 *
 * `AgentRuntimeStore` is a nominal brand (`{ readonly [agentRuntimeStore]: true }`)
 * on purpose: hosts get a handle they can hand to `createAgentRuntime` and
 * nothing else, so no product code can start reading rows behind the runtime's
 * back. Store tests, though, exist precisely to assert what got persisted, so
 * they need the concrete surface — reached here, once, by name, instead of
 * scattered casts that also silently switch off every other check.
 */
/**
 * `finishTurn` and `close` are optional on the port because a host may ship a
 * store without them; every store in this package descends from
 * `MemoryRuntimeStore`, which implements both, so tests may call them directly.
 * `Omit<T, keyof AgentRuntimeStore>` keeps whatever a specific handle adds on top
 * (e.g. Convex's `flush`/`syncSession`).
 */
export type StoreRows<T extends AgentRuntimeStore> =
  & AgentRuntimeStoreWithRecovery
  & Required<Pick<AgentRuntimeStoreWithRecovery, "finishTurn" | "close">>
  & Omit<T, keyof AgentRuntimeStore>

export function storeRows<T extends AgentRuntimeStore>(store: T): StoreRows<T> {
  return store as unknown as StoreRows<T>
}
