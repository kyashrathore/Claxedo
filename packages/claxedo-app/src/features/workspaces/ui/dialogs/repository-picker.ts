export type RepositoryChoice = {
  connectionId: string
  id: string
  name: string
  fullName: string
  private: boolean
  permissions: { read: boolean; write: boolean }
}

/**
 * The integration row as the connect dialog needs it.
 *
 * Structurally identical to `IntegrationInfo` in
 * `features/settings/ui/connections-logic.ts` — deliberately re-declared rather
 * than imported, because a feature may not import another feature (the shell
 * composes that seam). Both are parses of the SAME wire shape, so structural
 * assignability is what makes handing one to the connect dialog typecheck.
 */
export type IntegrationChoice = {
  id: string
  name: string
  methods: ("key" | "oauth")[]
  capabilities: string[]
  prompts?: { id: string; label: string; placeholder?: string; secret?: boolean }[]
}

export type RepositoryPickerState = {
  repositories: RepositoryChoice[]
  /**
   * The GitHub integration this deployment offers, present only while NO GitHub
   * connection is usable yet. That is exactly when the dialog must offer to
   * connect one: with zero connected repositories and no connect affordance,
   * the create-project flow simply dead-ends, which is the state a hosted user
   * lands in on their first visit.
   */
  connectGitHub?: IntegrationChoice
}

function parseIntegration(value: unknown): IntegrationChoice | undefined {
  if (!value || typeof value !== "object") return undefined
  const row = value as Record<string, unknown>
  if (row.id !== "github" || typeof row.name !== "string") return undefined
  const methods = Array.isArray(row.methods)
    ? row.methods.filter((method): method is "key" | "oauth" => method === "key" || method === "oauth")
    : []
  if (!methods.length) return undefined
  return {
    id: row.id,
    name: row.name,
    methods,
    capabilities: Array.isArray(row.capabilities)
      ? row.capabilities.filter((item): item is string => typeof item === "string")
      : [],
    ...(Array.isArray(row.prompts) ? { prompts: row.prompts as IntegrationChoice["prompts"] } : {}),
  }
}

function parseConnections(body: { connections?: unknown[] } | undefined) {
  return (body?.connections ?? []).flatMap((value): Array<{ id: string }> => {
    if (!value || typeof value !== "object") return []
    const row = value as Record<string, unknown>
    if (typeof row.id !== "string" || row.integrationId !== "github" || row.status !== "connected") return []
    return [{ id: row.id }]
  })
}

async function listing(request: (path: string) => Promise<Response>) {
  const response = await request("")
  if (!response.ok) throw new Error(`Connections request failed: ${response.status}`)
  return (await response.json().catch(() => undefined)) as
    | {
        connections?: unknown[]
        integrations?: unknown[]
      }
    | undefined
}

async function repositoriesFor(request: (path: string) => Promise<Response>, connections: Array<{ id: string }>) {
  return (
    await Promise.all(
      connections.map(async (connection) => {
        const response = await request(`/connections/${encodeURIComponent(connection.id)}/repositories`)
        if (!response.ok) {
          const error = (await response.json().catch(() => undefined)) as { code?: unknown } | undefined
          const code = typeof error?.code === "string" ? error.code : "repository_provider_unavailable"
          if (code === "repository_provider_unauthorized") throw new Error("Reconnect GitHub to list repositories.")
          throw new Error("GitHub repositories are temporarily unavailable. Retry in a moment.")
        }
        const result = (await response.json().catch(() => undefined)) as { repositories?: unknown[] } | undefined
        return (result?.repositories ?? []).flatMap((value): RepositoryChoice[] => {
          if (!value || typeof value !== "object") return []
          const row = value as Record<string, unknown>
          const permissions =
            row.permissions && typeof row.permissions === "object" ? (row.permissions as Record<string, unknown>) : {}
          if (
            typeof row.id !== "string" ||
            typeof row.name !== "string" ||
            typeof row.fullName !== "string" ||
            typeof row.private !== "boolean"
          )
            return []
          return [
            {
              connectionId: connection.id,
              id: row.id,
              name: row.name,
              fullName: row.fullName,
              private: row.private,
              permissions: { read: permissions.read === true, write: permissions.write === true },
            },
          ]
        })
      }),
    )
  ).flat()
}

export async function loadConnectedRepositories(request: (path: string) => Promise<Response>) {
  return repositoriesFor(request, parseConnections(await listing(request)))
}

/**
 * One listing round-trip that answers BOTH questions the create-project dialog
 * has: which repositories can I offer, and — when the answer is none — can I
 * offer to connect GitHub instead of dead-ending?
 */
export async function loadRepositoryPickerState(
  request: (path: string) => Promise<Response>,
): Promise<RepositoryPickerState> {
  const body = await listing(request)
  const connections = parseConnections(body)
  const repositories = await repositoriesFor(request, connections)
  if (repositories.length) return { repositories }
  // Offer the connect path whenever nothing is listable — including the case
  // where a connection exists but returned no repositories, since reconnecting
  // is the only in-app move left.
  const integration = (body?.integrations ?? []).map(parseIntegration).find(Boolean)
  return { repositories, ...(integration ? { connectGitHub: integration } : {}) }
}
