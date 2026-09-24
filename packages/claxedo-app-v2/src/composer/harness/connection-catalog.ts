import { createSignal } from "solid-js"
import type { HarnessConnectionsCatalog } from "@claxedo/agent-runtime-contract"
import type { HarnessConfigApi } from "@/server"

export function createHarnessConnectionsCatalog(input: { api: HarnessConfigApi }) {
  const [data, setData] = createSignal<HarnessConnectionsCatalog>()
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string>()

  const refresh = async () => {
    setLoading(true)
    setError()
    try {
      setData(await input.api.connections())
    } catch (cause) {
      setData()
      setError(cause instanceof Error ? cause.message : "Failed to load agent connections")
    } finally {
      setLoading(false)
    }
  }

  return { data, loading, error, refresh }
}
