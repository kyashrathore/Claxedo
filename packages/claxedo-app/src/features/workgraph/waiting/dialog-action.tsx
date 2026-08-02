import type { CommandResult } from "@claxedo/workgraph/contracts"
import { createSignal, Show } from "solid-js"

/** Tracks busy/error for a domain mutation and reports success upstream. */
export function createAction(onSuccess: () => void) {
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const run = async (fn: () => Promise<CommandResult | unknown>) => {
    if (busy()) return false
    setBusy(true)
    setError()
    try {
      const result = await fn()
      if (result && typeof result === "object" && "ok" in result && (result as CommandResult).ok === false) {
        setError((result as CommandResult & { ok: false }).error.message)
        return false
      }
      onSuccess()
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, run }
}

export function ActionError(props: { message?: string }) {
  return (
    <Show when={props.message}>
      <p class="workgraph-detail-status is-error" role="alert">
        {props.message}
      </p>
    </Show>
  )
}
