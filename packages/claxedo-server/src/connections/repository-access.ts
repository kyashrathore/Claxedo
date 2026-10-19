import type { ConnectionsService, ConnectionSummary } from "@claxedo/connections"
import type { RepositoryConnectionAccess } from "../workspace/route-support"

/**
 * Which of the caller's `connections` reads `fullName`: the one named
 * `connectionId`, or with none named the first code-host connection that lists
 * the repository readable, personal before organization. A listing that failed
 * outranks a plain "not listed", since that connection may still have been the
 * one.
 */
export async function readableCodeHostRepository(
  service: Pick<ConnectionsService, "listRepositories">,
  connections: readonly ConnectionSummary[],
  connectionId: string | undefined,
  fullName: string,
): Promise<RepositoryConnectionAccess> {
  const candidates = connections
    .filter((connection) => connectionId === undefined
      ? connection.grantedCapabilities.includes("code-host") && connection.status !== "broken"
      : connection.id === connectionId)
    .sort((a, b) => Number(b.scope === "personal") - Number(a.scope === "personal"))
  const answers = await Promise.all(candidates.map((connection) => readableThrough(service, connection.id, fullName)))
  return answers.find((answer) => answer.ok)
    ?? answers.find((answer) => !answer.ok && answer.status >= 500)
    ?? answers.find((answer) => !answer.ok && answer.code === "repository_read_required")
    ?? answers[0]
    ?? { ok: false, status: 404, code: "connection_not_found" }
}

async function readableThrough(
  service: Pick<ConnectionsService, "listRepositories">,
  connectionId: string,
  fullName: string,
): Promise<RepositoryConnectionAccess> {
  const listed = await service.listRepositories(connectionId)
  if (!listed.ok) return listed
  const wanted = fullName.toLowerCase()
  const repository = listed.repositories.find((item) => item.fullName.toLowerCase() === wanted)
  if (!repository) return { ok: false, status: 404, code: "repository_not_found" }
  if (!repository.permissions.read) return { ok: false, status: 403, code: "repository_read_required" }
  return { ok: true, repository, connectionId }
}
