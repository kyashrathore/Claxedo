import type { SessionCleanupGrant } from "@claxedo/mcp"
import { listWorkspaces, type Workspace } from "@claxedo/server-core/workspace/store/index"
import { hostServingPublisherCredential } from "@claxedo/host-serving/serving"
import { asRecord } from "@claxedo/helpers/guards"
import { localSessionCleanupGrant } from "./cleanup-grant"
import { hostSessionCleanupGrant } from "./host-cleanup-grant"
import { localHostSessionRowsUrl } from "../deployments/local/host-session-authority"

type Source = "local" | "account"
type Cursor = { source: Source; cursor?: string; query: string }

export function sessionCleanupGrant(input: {
  workspaceId: string
  sessionId: string
  ownerDriven(): boolean
  fetch(request: Request): Promise<Response> | Response
  refreshSessionProjection?: (workspace: Workspace) => Promise<void>
  account?: SessionCleanupGrant
  accountConfigured?(): boolean
}): SessionCleanupGrant {
  const local = localSessionCleanupGrant({ ...input, excludeWorkspaces: async () => [...new Set([
    ...(await listWorkspaces()).filter((row) => !!row.org_id).map((row) => row.id),
    ...hostServingPublisherCredential()?.workspaceIds ?? [],
  ])] })
  const account = input.account ?? hostSessionCleanupGrant(input)
  const sources = { local, account }
  return {
    allowed: () => input.ownerDriven(),
    fetch: async (path, init) => {
      if (!input.ownerDriven()) return Response.json({ error: { code: "cleanup_capability_revoked", message: "The session's user authority changed" } }, { status: 403 })
      const url = new URL(path, "http://cleanup.local")
      const workspaces = await listWorkspaces()
      const accountIds = new Set([...workspaces.filter((row) => !!row.org_id).map((row) => row.id), ...hostServingPublisherCredential()?.workspaceIds ?? []])
      if (url.pathname.endsWith("/delete")) return deleteBySource(path, init, sources, accountIds, workspaces)
      return readBySource(url, sources, accountIds, workspaces, input.accountConfigured?.() || account.allowed() || !!localHostSessionRowsUrl() || accountIds.size > 0)
    },
  }
}

async function readBySource(url: URL, sources: Record<Source, SessionCleanupGrant>, accountIds: ReadonlySet<string>, workspaces: readonly Workspace[], hasAccount: boolean) {
  const named = url.searchParams.get("workspaceId")
  const signature = cleanupInventoryQuerySignature(url.searchParams)
  const cursor = readCursor(url.searchParams.get("cursor"), signature)
  if (cursor instanceof Response) return cursor
  const source = cursor?.source ?? (named && (accountIds.has(named) || !workspaces.some((row) => row.id === named)) ? "account" : "local")
  const query = new URLSearchParams(url.searchParams)
  if (cursor?.cursor) query.set("cursor", cursor.cursor)
  else query.delete("cursor")
  const response = await sources[source].fetch(`${url.pathname}?${query}`)
  if (source === "account" && (response.status === 401 || response.status === 403)) {
    return Response.json({ candidates: [], incompleteSources: [{ ...(named ? { workspaceId: named } : {}), reason: `Account cleanup authority was refused (${response.status})` }] })
  }
  if (!response.ok) return response
  const page = asRecord(await response.json())
  if (!page || !Array.isArray(page.candidates) || !Array.isArray(page.incompleteSources)) throw new Error("Cleanup source returned an invalid page")
  const next = typeof page.nextCursor === "string" ? { source, cursor: page.nextCursor, query: signature }
    : !named && source === "local" && hasAccount ? { source: "account" as const, query: signature } : undefined
  return Response.json({ ...page, nextCursor: next ? Buffer.from(JSON.stringify(next)).toString("base64url") : undefined })
}

async function deleteBySource(path: string, init: RequestInit | undefined, sources: Record<Source, SessionCleanupGrant>, accountIds: ReadonlySet<string>, workspaces: readonly Workspace[]) {
  const body = asRecord(await new Response(init?.body).json())
  if (!Array.isArray(body?.targets) || typeof body.cascade !== "boolean") return Response.json({ error: { code: "invalid_cleanup", message: "Invalid cleanup body" } }, { status: 400 })
  const results = []
  for (const item of body.targets) {
    const target = asRecord(item)
    if (typeof target?.workspaceId !== "string" || typeof target.sessionId !== "string") return Response.json({ error: { code: "invalid_cleanup", message: "Invalid cleanup target" } }, { status: 400 })
  }
  for (const item of body.targets) {
    const target = asRecord(item)!
    const source = accountIds.has(String(target.workspaceId)) || !workspaces.some((row) => row.id === target.workspaceId) ? "account" : "local"
    try {
      const response = await sources[source].fetch(path, { ...init, body: JSON.stringify({ targets: [item], cascade: body.cascade }) })
      if (!response.ok) {
        const refused = response.status < 500 && response.status !== 408
        results.push({ sessionId: target.sessionId, workspaceId: target.workspaceId, status: refused ? "failed" : "unknown", code: refused ? "cleanup_unavailable" : "outcome_unknown", message: await response.text() })
        continue
      }
      const result = asRecord(await response.json())
      if (!Array.isArray(result?.results) || result.results.length !== 1) throw new Error("Cleanup source returned no exact receipt")
      results.push(result.results[0])
    } catch (error) {
      results.push({ sessionId: target.sessionId, workspaceId: target.workspaceId, status: "unknown", code: "outcome_unknown", message: error instanceof Error ? error.message : String(error) })
    }
  }
  return Response.json({ results, deletion: "logical", journalRetained: true })
}

function cleanupInventoryQuerySignature(query: URLSearchParams) {
  const fields = new URLSearchParams(query)
  fields.delete("cursor")
  fields.sort()
  return fields.toString()
}

function readCursor(value: string | null, query: string): Cursor | Response | undefined {
  if (!value) return undefined
  try {
    const decoded = asRecord(JSON.parse(Buffer.from(value, "base64url").toString()))
    if (decoded?.query === query && (decoded.source === "local" || decoded.source === "account") && (decoded.cursor === undefined || typeof decoded.cursor === "string")) {
      return { source: decoded.source, cursor: decoded.cursor, query }
    }
  } catch {}
  return Response.json({ error: { code: "invalid_session_list_cursor", message: "Cleanup cursor does not match this query" } }, { status: 400 })
}
