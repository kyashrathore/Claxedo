export type RepositoryChoice = {
  connectionId: string
  id: string
  name: string
  fullName: string
  private: boolean
  permissions: { read: boolean; write: boolean }
}

export async function loadConnectedRepositories(request: (path: string) => Promise<Response>) {
  const listing = await request("")
  if (!listing.ok) throw new Error(`Connections request failed: ${listing.status}`)
  const body = await listing.json().catch(() => undefined) as { connections?: unknown[] } | undefined
  const connections = (body?.connections ?? []).flatMap((value): Array<{ id: string }> => {
    if (!value || typeof value !== "object") return []
    const row = value as Record<string, unknown>
    if (typeof row.id !== "string" || row.integrationId !== "github" || row.status !== "connected") return []
    return [{ id: row.id }]
  })
  return (await Promise.all(connections.map(async (connection) => {
    const response = await request(`/connections/${encodeURIComponent(connection.id)}/repositories`)
    if (!response.ok) {
      const error = await response.json().catch(() => undefined) as { code?: unknown } | undefined
      const code = typeof error?.code === "string" ? error.code : "repository_provider_unavailable"
      if (code === "repository_provider_unauthorized") throw new Error("Reconnect GitHub to list repositories.")
      throw new Error("GitHub repositories are temporarily unavailable. Retry in a moment.")
    }
    const result = await response.json().catch(() => undefined) as { repositories?: unknown[] } | undefined
    return (result?.repositories ?? []).flatMap((value): RepositoryChoice[] => {
      if (!value || typeof value !== "object") return []
      const row = value as Record<string, unknown>
      const permissions = row.permissions && typeof row.permissions === "object"
        ? row.permissions as Record<string, unknown>
        : {}
      if (
        typeof row.id !== "string" ||
        typeof row.name !== "string" ||
        typeof row.fullName !== "string" ||
        typeof row.private !== "boolean"
      ) return []
      return [{
        connectionId: connection.id,
        id: row.id,
        name: row.name,
        fullName: row.fullName,
        private: row.private,
        permissions: { read: permissions.read === true, write: permissions.write === true },
      }]
    })
  }))).flat()
}
