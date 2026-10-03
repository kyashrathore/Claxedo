import { z } from "zod"
import { asRecord } from "@claxedo/helpers/guards"
import { workspaceRuntimeClientError, WorkspaceRuntimeClientError } from "@claxedo/workspace-runtime/client"
import type { SessionCleanupPage } from "@claxedo/agent-runtime-contract"
import type { ClaxedoFetch } from "../client/contract"
import type { ToolRegistrar } from "./registry"
import { declaredToolAccess } from "./inventory"
import { toolJson } from "./target"

const position = {
  sessionId: z.string().trim().min(1),
  generation: z.number().int().nonnegative(),
  activitySequence: z.number().int().nonnegative(),
}

const target = z.strictObject({
  ...position,
  workspaceId: z.string().trim().min(1),
  readerRevision: z.number().int().nonnegative(),
  descendants: z.array(z.strictObject(position)),
})

const access = { audiences: ["runtime", "user"] as const, sessionCleanup: true as const }

export function registerSessionCleanupTools(registry: ToolRegistrar) {
  registry.tool("sessions_cleanup_list", {
    description: "Find every matching root session for cleanup using server-owned seen/settled state and date bounds. Reads every page. Returns exact delete targets and explicit incomplete/offline sources; it never deletes anything.",
    inputSchema: {
      workspace: z.string().trim().min(1).optional().describe("Only this workspace; absent searches the authorized inventory."),
      seen: z.enum(["seen", "unseen", "all"]).optional(),
      settled: z.enum(["active", "settled", "all"]).optional(),
      dateField: z.enum(["created", "activity", "settled"]).optional(),
      from: z.iso.datetime({ offset: true }).optional().describe("Inclusive start, ISO timestamp with explicit timezone."),
      until: z.iso.datetime({ offset: true }).optional().describe("Exclusive end, ISO timestamp with explicit timezone."),
      archived: z.enum(["active", "archived", "all"]).optional(),
    },
    access: declaredToolAccess({ ...access, scope: "read", write: false }),
  }, async (args, ctx) => {
    const query = new URLSearchParams({ limit: "200", seen: args.seen ?? "all", settled: args.settled ?? "all", archived: args.archived ?? "all" })
    if (args.workspace) query.set("workspaceId", args.workspace)
    for (const key of ["dateField", "from", "until"] as const) if (args[key]) query.set(key, args[key])
    const result = await readCleanupSelection(ctx.client.sessionCleanup!.fetch, query)
    return toolJson(result)
  })
  registry.tool("sessions_delete", {
    description: "Logically delete exact targets returned by sessions_cleanup_list after confirmation. Reader state must match at command admission; runtime activity must match when deletion executes. Later reader changes do not cancel an admitted command. Returns every success/failure. Child sessions are included only with cascade=true. Runtime journals remain retained.",
    inputSchema: {
      targets: z.array(target).min(1).describe("Exact positions from sessions_cleanup_list; do not refresh them implicitly."),
      cascade: z.boolean().describe("Explicitly approve deletion of the child sessions named in each target."),
    },
    access: declaredToolAccess({ ...access, scope: "admin", write: true, destructive: true }),
    targetsOf: (args) => args.targets.map(({ sessionId, workspaceId }) => ({ sessionId, workspaceId })),
    confirmation: (args) => `Delete ${args.targets.length} selected root session(s) and ${args.cascade ? args.targets.reduce((sum, row) => sum + row.descendants.length, 0) : 0} child session(s)?\n${args.targets.map((row) => `${row.workspaceId}/${row.sessionId}`).join("\n")}\nThis removes them from Claxedo; runtime journals remain retained.`,
  }, async (args, ctx) => {
    const identities = args.targets.map((row) => `${row.workspaceId}/${row.sessionId}`)
    if (new Set(identities).size !== identities.length) throw new Error("Duplicate cleanup target")
    const results: unknown[] = []
    for (let offset = 0; offset < args.targets.length; offset += 200) {
      const batch = args.targets.slice(offset, offset + 200)
      let response: Response
      try {
        response = await ctx.client.sessionCleanup!.fetch("/api/claxedo/session-cleanup/delete", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ targets: batch, cascade: args.cascade }),
        })
      } catch (error) {
        for (const row of batch) results.push({ sessionId: row.sessionId, workspaceId: row.workspaceId, status: "unknown", code: "outcome_unknown", message: `No deletion receipt was received: ${error instanceof Error ? error.message : String(error)}` })
        continue
      }
      if (!response.ok) {
        const failure = await workspaceRuntimeClientError("sessions.delete", response)
        const knownRefusal = response.status >= 400 && response.status < 500 && response.status !== 408
        for (const row of batch) results.push({ sessionId: row.sessionId, workspaceId: row.workspaceId, status: knownRefusal ? "failed" : "unknown", code: knownRefusal ? "cleanup_unavailable" : "outcome_unknown", message: failure.message })
        continue
      }
      try {
        const body = asRecord(await response.json())
        if (!Array.isArray(body?.results) || body.results.length !== batch.length) throw new Error("Session cleanup returned an incomplete deletion receipt")
        const parsed = body.results.map((value) => cleanupDeleteResult.parse(value))
        for (let i = 0; i < batch.length; i++) {
          if (parsed[i]?.sessionId !== batch[i]?.sessionId || parsed[i]?.workspaceId !== batch[i]?.workspaceId) throw new Error("Session cleanup returned a receipt for another target")
        }
        results.push(...parsed)
      } catch (error) {
        for (const row of batch) results.push({ sessionId: row.sessionId, workspaceId: row.workspaceId, status: "unknown", code: "outcome_unknown", message: `Invalid deletion receipt: ${error instanceof Error ? error.message : String(error)}` })
      }
    }
    return toolJson({ results, deletion: "logical", journalRetained: true })
  })
}

export async function readCleanupSelection(fetch: ClaxedoFetch, query: URLSearchParams) {
  const candidates: SessionCleanupPage["candidates"][number][] = []
  const incompleteSources: SessionCleanupPage["incompleteSources"][number][] = []
  const visited = new Set<string>()
  const identities = new Set<string>()
  for (;;) {
    let response: Response
    let page: SessionCleanupPage
    try {
      response = await fetch(`/api/claxedo/session-cleanup?${query}`, { method: "GET" })
      if (!response.ok) throw await workspaceRuntimeClientError("sessions.cleanup.list", response)
      page = cleanupPage(await response.json())
    } catch (error) {
      if (error instanceof WorkspaceRuntimeClientError && error.status < 500 && error.status !== 429 && error.status !== 408) throw error
      incompleteSources.push({ reason: error instanceof Error ? error.message : String(error) })
      break
    }
    for (const row of page.candidates) {
      const identity = `${row.workspaceId}/${row.sessionId}`
      if (identities.has(identity)) continue
      identities.add(identity)
      candidates.push(row)
    }
    incompleteSources.push(...page.incompleteSources)
    if (!page.nextCursor) break
    if (visited.has(page.nextCursor)) throw new Error("Session cleanup repeated its pagination cursor")
    visited.add(page.nextCursor)
    query.set("cursor", page.nextCursor)
  }
  return { candidates, incompleteSources, complete: incompleteSources.length === 0 }
}

const identity = { sessionId: z.string().min(1), workspaceId: z.string().min(1) }
const cleanupDeleteResult = z.union([
  z.strictObject({ ...identity, status: z.literal("deleted"), deletedSessionIds: z.array(z.string().min(1)) }),
  z.strictObject({ ...identity, status: z.literal("failed"), code: z.string(), message: z.string(), deletedSessionIds: z.array(z.string()).optional() }),
  z.strictObject({ ...identity, status: z.literal("unknown"), code: z.literal("outcome_unknown"), message: z.string() }),
])

function cleanupPage(input: unknown): SessionCleanupPage {
  const candidate = target.extend({ title: z.string(), createdAt: z.number(), activityAt: z.number(), settledAt: z.number().optional(), seen: z.boolean(), settled: z.boolean() })
  return z.strictObject({
    candidates: z.array(candidate),
    incompleteSources: z.array(z.strictObject({ workspaceId: z.string().optional(), sessionId: z.string().optional(), reason: z.string() })),
    nextCursor: z.string().min(1).optional(),
  }).parse(input)
}
