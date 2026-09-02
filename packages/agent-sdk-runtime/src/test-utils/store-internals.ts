import type { AgentRuntimeStore } from "../runtime"
import type { AgentRuntimeStoreWithRecovery } from "../harnesses/shared/runtime-store"

/** Exposes row-level store operations to persistence tests without widening the public handle. */
export type StoreRows<T extends AgentRuntimeStore> =
  & AgentRuntimeStoreWithRecovery
  & Required<Pick<AgentRuntimeStoreWithRecovery, "close">>
  & Omit<T, keyof AgentRuntimeStore>

export function storeRows<T extends AgentRuntimeStore>(store: T): StoreRows<T> {
  return store as unknown as StoreRows<T>
}
