import type { AgentPluginConnectionPort, AgentPluginConnectionSummary } from "@/features/agent-plugins/connections"
import type { ConnectionsRequest } from "@/platform/account/integrations-request"

/**
 * The marketplace's connection port over the ONE integrations request the
 * app has (`createIntegrationsRequest`): signed desktop → named account
 * operations, browser / unsigned → authenticated fetch. Both answer with a
 * `Response`, so the port never has to know which path served it.
 *
 * It used to carry its own desktop path that expected `{ status, body }`
 * from `account.run("connections.list")`; that operation is a decoded one
 * (it returns the body itself), so every marketplace open failed with
 * "Hosted operation returned an invalid response status".
 */
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

export function connectionSummary(value: unknown): AgentPluginConnectionSummary | undefined {
  if (!record(value)) return undefined
  const row = value
  if (
    typeof row.id !== "string"
    || typeof row.integrationId !== "string"
    || (row.scope !== "personal" && row.scope !== "team")
    || (row.status !== "connected" && row.status !== "degraded" && row.status !== "broken")
  ) return undefined
  return { id: row.id, integrationId: row.integrationId, scope: row.scope, status: row.status }
}

async function failure(response: Response, label: string) {
  const body: unknown = await response.json().catch(() => undefined)
  const nested = record(body) && record(body.error) ? body.error : undefined
  const detail = typeof nested?.message === "string"
    ? nested.message
    : record(body) && typeof body.message === "string"
      ? body.message
      : record(body) && typeof body.code === "string"
        ? body.code
        : undefined
  return new Error(`${label} (${response.status}${detail ? `: ${detail}` : ""})`)
}

export function agentPluginConnectionPort(input: {
  request: ConnectionsRequest
  open: AgentPluginConnectionPort["open"]
}): AgentPluginConnectionPort {
  return {
    async load() {
      const response = await input.request("")
      if (!response.ok) throw await failure(response, "Connections request failed")
      const body: unknown = await response.json().catch(() => undefined)
      const rows = record(body) && Array.isArray(body.connections) ? body.connections : []
      return {
        connections: rows
          .map(connectionSummary)
          .filter((row): row is AgentPluginConnectionSummary => row !== undefined),
      }
    },
    open: input.open,
    async disconnect(connectionId) {
      const response = await input.request(`/connections/${encodeURIComponent(connectionId)}`, { method: "DELETE" })
      if (!response.ok && response.status !== 404) throw await failure(response, "Disconnect failed")
    },
  }
}
