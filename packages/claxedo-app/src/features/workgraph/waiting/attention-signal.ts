import { createRoot, createSignal } from "solid-js"

/**
 * WorkGraph attention state, shared so the one top-level WorkspacePanel toggle can
 * render its attention dot without a second toggle or panel shell. `WorkGraphContent`
 * publishes the live Attention total here; the shell chrome reads it. It reflects
 * the strict Attention endpoint only — never the snapshot — and resets to 0 when the
 * WorkGraph surface unmounts.
 *
 * The signal lives inside an explicit app-lifetime `createRoot` scope so this
 * cross-tree reactive state has a real reactive owner.
 */
const attention = createRoot(() => {
  const [count, setCount] = createSignal(0)
  return { count, setCount }
})

export const workGraphAttentionCount = attention.count
export const setWorkGraphAttentionCount = attention.setCount
export const workGraphHasAttention = () => attention.count() > 0
