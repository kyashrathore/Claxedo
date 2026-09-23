import { createSignal } from "solid-js"
import { decodeHarnessConnectionsCatalog, type HarnessConnectionsCatalog } from "@claxedo/agent-runtime-contract"

export function createHarnessConnectionsCatalog(input: { base: string; request: typeof fetch }) {
  const [data, setData] = createSignal<HarnessConnectionsCatalog>()
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string>()

  const refresh = async () => {
    setLoading(true)
    setError()
    try {
      const response = await input.request(new URL("/api/claxedo/agent-config/connections", input.base))
      if (!response.ok) throw new Error(`Failed to load agent connections (status ${response.status})`)
      setData(decodeHarnessConnectionsCatalog(await response.json()))
    } catch (cause) {
      setData()
      setError(cause instanceof Error ? cause.message : "Failed to load agent connections")
    } finally {
      setLoading(false)
    }
  }

  const remove = async (connectionId: string) => {
    if (data()?.status !== "supported") return { ok: false, error: "Agent connection management is unavailable" }
    try {
      const response = await input.request(
        new URL(`/api/claxedo/agent-config/connections/${encodeURIComponent(connectionId)}`, input.base),
        { method: "DELETE" },
      )
      if (!response.ok) return { ok: false, error: `Remove failed (status ${response.status})` }
      await refresh()
      return { ok: true }
    } catch (cause) {
      return { ok: false, error: cause instanceof Error ? cause.message : "Remove failed" }
    }
  }

  return { data, loading, error, refresh, remove }
}
