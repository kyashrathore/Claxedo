import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { PublicApiError } from "../platform/errors/public-api-error"
import { ClaxedoError } from "../platform/errors/base"
import { parseSessionListQuery } from "./navigation-list"
import { sessionCleanupCandidate, sessionCleanupDeleteSchema, type SessionCleanupPort } from "./cleanup"
import type { SessionCleanupDeleteResult, SessionCleanupIncompleteSource } from "@claxedo/agent-runtime-contract"
import { WorkspaceRuntimeClientError, WorkspaceRuntimeClientTransportError } from "@claxedo/workspace-runtime/client"
import { asRecord } from "@claxedo/helpers/guards"

export type { SessionCleanupPort } from "./cleanup"

export function SessionCleanupRoutes(input: { authenticate(request: Request): Promise<SessionCleanupPort | Response> }) {
  return new Hono()
    .onError((error) => {
      if (error instanceof HTTPException) return error.getResponse()
      if (error instanceof ClaxedoError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status })
      throw error
    })
    .get("/api/claxedo/session-cleanup", async (c) => {
      const port = await input.authenticate(c.req.raw)
      if (port instanceof Response) return port
      const url = new URL(c.req.url)
      url.searchParams.set("scope", url.searchParams.has("workspaceId") ? "workspace" : "all")
      const query = parseSessionListQuery(url)
      const page = await port.list(query)
      const candidates = []
      const incompleteSources: SessionCleanupIncompleteSource[] = [...page.incompleteSources ?? []]
      for (const row of page.items) {
        const source = { workspaceId: row.workspaceId, sessionId: row.sessionId }
        if (!row.attention || !row.workspaceId) {
          incompleteSources.push({ ...source, reason: "Authoritative session facts are unavailable" })
          continue
        }
        try {
          const prepared = await port.prepare(row)
          if ("unavailable" in prepared) {
            incompleteSources.push({ ...source, reason: prepared.unavailable })
            continue
          }
          const candidate = sessionCleanupCandidate(row, prepared.descendants)
          if (candidate) candidates.push(candidate)
        } catch (error) {
          incompleteSources.push({ ...source, reason: error instanceof Error ? error.message : String(error) })
        }
      }
      return c.json({ candidates, incompleteSources, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) })
    })
    .post("/api/claxedo/session-cleanup/delete", async (c) => {
      const port = await input.authenticate(c.req.raw)
      if (port instanceof Response) return port
      const parsed = sessionCleanupDeleteSchema.safeParse(await c.req.json().catch(() => undefined))
      if (!parsed.success) throw new HTTPException(400, { message: "Invalid session cleanup targets" })
      const identities = parsed.data.targets.map((target) => `${target.workspaceId}/${target.sessionId}`)
      if (new Set(identities).size !== identities.length) throw new HTTPException(400, { message: "Duplicate cleanup target" })
      const results: SessionCleanupDeleteResult[] = []
      for (const target of parsed.data.targets) {
        const identity = { sessionId: target.sessionId, workspaceId: target.workspaceId }
        if (!parsed.data.cascade && target.descendants.length) {
          results.push({ ...identity, status: "failed", code: "cascade_required", message: "This session has child sessions. Explicit cascade approval is required." })
          continue
        }
        try {
          await port.admit(target)
          const result = await port.delete(target)
          results.push({ ...identity, status: "deleted", deletedSessionIds: result.deletedSessionIds })
        } catch (error) {
          if (unknownDeletionOutcome(error)) {
            results.push({ ...identity, status: "unknown", code: "outcome_unknown", message: error.message })
            continue
          }
          const fields = sessionCleanupFailureResult(error)
          results.push({ ...identity, status: "failed", ...fields })
        }
      }
      return c.json({ results, deletion: "logical", journalRetained: true })
    })
}

function sessionCleanupFailureResult(error: unknown) {
  if (error instanceof WorkspaceRuntimeClientError) {
    const details = asRecord(asRecord(asRecord(error.body)?.error)?.details)
    const deleted = details?.deletedSessionIds
    const deletedSessionIds = Array.isArray(deleted) && deleted.every((id) => typeof id === "string") ? deleted : undefined
    return { code: error.code, message: error.message, ...(deletedSessionIds ? { deletedSessionIds } : {}) }
  }
  if (error instanceof PublicApiError) return { code: error.code, message: error.message }
  if (error instanceof HTTPException) return { code: `http_${error.status}`, message: error.message }
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return { code: error.code, message: error instanceof Error ? error.message : error.code }
  }
  return { code: "delete_failed", message: error instanceof Error ? error.message : String(error) }
}

function unknownDeletionOutcome(error: unknown): error is Error {
  if (error instanceof WorkspaceRuntimeClientTransportError) return true
  if (!(error instanceof WorkspaceRuntimeClientError) || (error.status < 500 && error.status !== 408)) return false
  if (error.code !== "session_delete_failed") return true
  const details = asRecord(asRecord(asRecord(error.body)?.error)?.details)
  return !Array.isArray(details?.deletedSessionIds) || !details.deletedSessionIds.every((id) => typeof id === "string")
}
