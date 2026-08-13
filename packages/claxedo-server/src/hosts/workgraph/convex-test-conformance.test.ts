import { afterEach, describe, test, vi } from "vitest"
import { convexTest, type TestConvex } from "convex-test"
import type { Id } from "../../../../../convex/_generated/dataModel"
import { createChangeCursor, readChangeCursor } from "@claxedo/workgraph/contracts"
import type { RunRuntimePort } from "@claxedo/workgraph/ports"
import { workGraphAdapterConformance } from "@claxedo/workgraph/conformance"
import { api } from "../../../../../convex/_generated/api"
import schema from "../../../../../convex/schema"
import { createConvexWorkGraphService } from "./convex/store"

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>
  }
}

const modules = import.meta.glob("../../../../../convex/**/*.ts")

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe("convex-test AtomicWorkGraphStore conformance v9", () => {
  for (const conformance of workGraphAdapterConformance(async (input) => {
    vi.stubEnv("CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN", "service-secret")
    const clock = vi.spyOn(Date, "now").mockReturnValue(0)
    const convex = convexTest({ schema, modules })
    const tenant = await convex.run(async (ctx) => {
      const first = await ctx.db.insert("users", {
        token_identifier: String(input.owners.first.ownerUserId),
        clerk_subject: String(input.owners.first.ownerUserId),
        kind: "human",
        created_at: 1,
        updated_at: 1,
      })
      const second = await ctx.db.insert("users", {
        token_identifier: String(input.owners.second.ownerUserId),
        clerk_subject: String(input.owners.second.ownerUserId),
        kind: "human",
        created_at: 1,
        updated_at: 1,
      })
      const organization = await ctx.db.insert("orgs", {
        name: "Convex conformance",
        kind: "personal",
        owner_user_id: first,
        created_at: 1,
        updated_at: 1,
      })
      await Promise.all(
        [first, second].map((user) =>
          ctx.db.insert("org_memberships", {
            org_id: organization,
            user_id: user,
            role: "owner",
            created_at: 1,
            updated_at: 1,
          }),
        ),
      )
      await Promise.all(
        [
          [first, String(input.owners.first.ownerUserId)],
          [second, String(input.owners.second.ownerUserId)],
        ].map(([user, subject]) =>
          ctx.db.insert("workgraph_execution_capabilities", {
            organization_id: organization,
            owner_user_id: user as Id<"users">,
            schema_version: 1,
            catalog_revision: "a".repeat(64),
            observed_at: 1,
            expires_at: 300_001,
            attested_at: 1,
            catalog: {
              schemaVersion: 1,
              organizationId: organization,
              ownerUserId: subject,
              catalogRevision: "a".repeat(64),
              observedAt: 1,
              expiresAt: 300_001,
              environments: [{ kind: "hosted_workspace", repositoryRequired: false, remoteUrlInput: true, baseRevisionInput: true }],
              harnesses: [{ id: "claxedo-v2" }],
              agents: [{ harnessId: "claxedo-v2", id: "build", label: "Build" }],
              models: [
                {
                  harnessId: "claxedo-v2",
                  providerId: "openai",
                  modelId: "gpt-5",
                  label: "GPT-5",
                  efforts: ["low", "medium", "high"],
                },
              ],
              tools: [{ harnessId: "claxedo-v2", id: "read" }],
              repository: { remoteUrl: "https://example.test/repo.git", baseRevisions: ["HEAD"] },
              connections: [],
            },
          }),
        ),
      )
      return { organization, first, second }
    })
    const users = new Map([
      [String(input.owners.first.ownerUserId), tenant.first],
      [String(input.owners.second.ownerUserId), tenant.second],
    ])
    let failNextMutation = false
    const actual = convex as unknown as {
      mutation: (fn: unknown, args: Record<string, unknown>) => Promise<unknown>
      query: (fn: unknown, args: Record<string, unknown>) => Promise<unknown>
    }
    const args = (value: Record<string, unknown>) => {
      const ownerSubject = String(value.owner_subject)
      const ownerUserId = users.get(ownerSubject)
      const query = value.query && typeof value.query === "object" ? (value.query as Record<string, unknown>) : undefined
      const scope = query?.kind === "stream_changes" ? { type: "stream" as const, streamId: String(query.streamId) } : { type: "all" as const }
      const after =
        typeof query?.after === "string" && ownerUserId
          ? translateCursor(query.after, input.owners.first.organizationId, ownerSubject, tenant.organization, ownerUserId, scope)
          : undefined
      return {
        ...value,
        ...(query ? { query: { ...query, ...(after ? { after } : {}) } } : {}),
        ...(value.organization_id ? { organization_id: tenant.organization } : {}),
      }
    }
    const executor = {
      mutation: async (fn: unknown, value: Record<string, unknown>) => {
        if (failNextMutation) {
          failNextMutation = false
          throw new Error("injected append failure")
        }
        if (value.command) clock.mockReturnValue(input.clock.now())
        const result = await actual.mutation(fn, args(value))
        if (
          value.command &&
          typeof value.command === "object" &&
          "type" in value.command &&
          value.command.type === "delete_stream" &&
          result &&
          typeof result === "object" &&
          "ok" in result &&
          result.ok
        ) {
          await completeDeletion(convex, tenant.organization, users.get(String(value.owner_subject))!)
        }
        if (result && typeof result === "object" && "cursor" in result && typeof result.cursor === "string") {
          const ownerSubject = String(value.owner_subject)
          return {
            ...result,
            cursor: publicCursor(result.cursor, tenant.organization, users.get(ownerSubject)!, input.owners.first.organizationId, ownerSubject, { type: "all" }),
          }
        }
        return result
      },
      query: async (fn: unknown, value: Record<string, unknown>) => {
        const result = await actual.query(fn, args(value))
        const query = value.query as Record<string, unknown> | undefined
        const ownerSubject = String(value.owner_subject)
        const ownerUserId = users.get(ownerSubject)!
        const scope = query?.kind === "stream_changes" ? { type: "stream" as const, streamId: String(query.streamId) } : { type: "all" as const }
        if (Array.isArray(result) && (query?.kind === "changes" || query?.kind === "stream_changes")) {
          return result.map((change) => ({
            ...change,
            cursor: publicCursor(String(change.cursor), tenant.organization, ownerUserId, input.owners.first.organizationId, ownerSubject, scope),
          }))
        }
        if (result && typeof result === "object" && query?.kind === "snapshot" && "snapshotCursor" in result && typeof result.snapshotCursor === "string") {
          return {
            ...result,
            snapshotCursor: publicCursor(result.snapshotCursor, tenant.organization, ownerUserId, input.owners.first.organizationId, ownerSubject, { type: "all" }),
          }
        }
        return result
      },
    }
    const runRuntime = convexRunRuntime(convex, tenant.organization, users)
    return {
      service: createConvexWorkGraphService({ serviceToken: "service-secret", executor }),
      runRuntime,
      executionProfile: {
        environment: {
          kind: "hosted_workspace",
          placement: "shared",
          repositoryUrl: "https://github.com/claxedo/conformance.git",
        },
        repository: {
          remoteUrl: "https://github.com/claxedo/conformance.git",
          baseRevision: "HEAD",
        },
        harness: "claxedo-v2",
        agent: "build",
        model: { providerId: "openai", modelId: "gpt-5" },
        effort: "high",
        tools: [],
        connectionIds: [],
      },
      restart: async () => ({ runRuntime: convexRunRuntime(convex, tenant.organization, users) }),
      faults: {
        failNextAppend: () => {
          failNextMutation = true
        },
      },
      admit: async (owner, { workItemId }) => {
        const operationId = input.ids.next("admit") as never
        const ownerId = users.get(String(owner.ownerUserId))!
        const claims = await convex.mutation(api.workgraphRuntime.claimLaunches, {
          service_token: "service-secret",
          organization_id: tenant.organization,
          owner_user_id: ownerId,
          worker_id: "convex-test-conformance",
          now: input.clock.now(),
          limit: 25,
        })
        const claim = claims.find((candidate) => candidate.workItemId === workItemId)
        if (!claim) {
          return {
            ok: false,
            operationId,
            error: { code: "blocked", message: "No admitted Run", retryable: false },
          }
        }
        const marked = await convex.mutation(api.workgraphRuntime.markRunning, {
          service_token: "service-secret",
          organization_id: tenant.organization,
          owner_user_id: ownerId,
          outbox_id: claim.outboxId,
          run_id: claim.runId,
          lease_epoch: claim.leaseEpoch,
          worker_id: "convex-test-conformance",
          workspace_id: `workspace_${claim.runId}`,
          session_id: `session_${claim.runId}`,
          now: input.clock.now(),
        })
        if (!marked.settled) throw new Error("convex-test could not mark the conformance Run running")
        return {
          ok: true,
          operationId,
          cursor: createChangeCursor({
            organizationId: owner.organizationId,
            ownerUserId: owner.ownerUserId,
            position: 1,
          }),
          value: { runId: claim.runId, leaseEpoch: claim.leaseEpoch },
        }
      },
    }
  }))
    test(conformance.name, conformance.run)
})

function convexRunRuntime(convex: TestConvex<typeof schema>, organization: Id<"orgs">, users: ReadonlyMap<string, Id<"users">>): RunRuntimePort {
  const owner = (subject: string) => users.get(subject)!
  const run = async (runId: string) =>
    convex.run((ctx) =>
      ctx.db
        .query("workgraph_runs")
        .withIndex("by_tenant_id", (query) => query.eq("organization_id", organization))
        .filter((query) => query.eq(query.field("id"), runId))
        .unique(),
    )
  return {
    listReconcilable: async (context) =>
      convex.run(async (ctx) => {
        const ownerUserId = owner(String(context.ownerUserId))
        const runs = await ctx.db
          .query("workgraph_runs")
          .withIndex("by_tenant_id", (query) => query.eq("organization_id", organization).eq("owner_user_id", ownerUserId))
          .collect()
        const leases = await ctx.db
          .query("workgraph_leases")
          .withIndex("by_tenant_resource", (query) => query.eq("organization_id", organization).eq("owner_user_id", ownerUserId))
          .collect()
        return runs
          .filter((row) => row.state === "running" && row.session_id && row.envelope_id)
          .flatMap((row) => {
            const lease = leases.find((candidate) => candidate.resource_id === row.work_item_id && candidate.holder_id === row.id && candidate.epoch === row.generation)
            return lease
              ? [
                  {
                    runId: row.id,
                    streamId: row.stream_id,
                    workItemId: row.work_item_id,
                    sessionId: row.session_id!,
                    envelopeId: row.envelope_id!,
                    childIsolationId: row.child_workspace_id ?? null,
                    profileJson: JSON.stringify(row.resolved_execution),
                    leaseEpoch: lease.epoch,
                    leaseExpiresAt: lease.expires_at,
                  },
                ]
              : []
          })
      }) as never,
    renewLease: async (context, input) => {
      const renewed = await convex.mutation(api.workgraphRuntime.renewRunLease, {
        service_token: "service-secret",
        organization_id: organization as never,
        owner_user_id: owner(String(context.ownerUserId)) as never,
        run_id: input.runId,
        lease_epoch: input.expectedLeaseEpoch,
        now: input.occurredAt,
        duration_ms: input.durationMs,
      })
      return renewed ?? undefined
    },
    park: async () => undefined,
    requestCompletionRetry: async (context, input) => {
      const current = await run(String(input.runId))
      if (!current?.session_id || current.owner_user_id !== owner(String(context.ownerUserId))) {
        return { accepted: false }
      }
      return await convex.mutation(api.workgraphRuntime.requestCompletionRetry, {
        service_token: "service-secret",
        organization_id: organization as never,
        owner_user_id: owner(String(context.ownerUserId)) as never,
        run_id: input.runId,
        session_id: current.session_id,
        lease_epoch: input.leaseEpoch,
        terminal_seq: input.terminalSeq,
        now: input.occurredAt,
      })
    },
    recordResult: async (context, input) => {
      if (input.state !== "result") return false
      const current = await run(String(input.runId))
      if (!current?.session_id || current.owner_user_id !== owner(String(context.ownerUserId))) return false
      return (
        await convex.mutation(api.workgraphRuntime.recordResult, {
          service_token: "service-secret",
          organization_id: organization as never,
          owner_user_id: owner(String(context.ownerUserId)) as never,
          run_id: input.runId,
          lease_epoch: input.leaseEpoch,
          session_id: current.session_id,
          summary: input.summary,
          artifacts: input.artifacts,
          now: Date.now(),
        })
      ).settled
    },
  }
}

async function completeDeletion(convex: TestConvex<typeof schema>, organization: Id<"orgs">, owner: Id<"users">) {
  for (;;) {
    const effects = await convex.mutation(api.workgraphRuntime.claimControlEffects, {
      service_token: "service-secret",
      organization_id: organization as never,
      owner_user_id: owner as never,
      worker_id: "convex-test-conformance",
      now: Date.now(),
      limit: 25,
    })
    const effect = effects[0]
    if (!effect) return
    const result = await convex.mutation(api.workgraphRuntime.completeControlEffect, {
      service_token: "service-secret",
      organization_id: organization as never,
      owner_user_id: owner as never,
      outbox_id: effect.outboxId,
      worker_id: "convex-test-conformance",
      ok: true,
      now: Date.now(),
    })
    if (result.retryAfterMs === undefined) return
  }
}

function translateCursor(
  cursor: string,
  publicOrganization: string,
  publicOwner: string,
  organization: Id<"orgs">,
  owner: Id<"users">,
  scope: { type: "all" } | { type: "stream"; streamId: string },
) {
  try {
    return createChangeCursor({
      organizationId: organization as never,
      ownerUserId: owner as never,
      scope: scope as never,
      position: readChangeCursor(cursor as never, publicOrganization as never, publicOwner as never, scope as never),
    })
  } catch {
    return cursor
  }
}

function publicCursor(
  cursor: string,
  organization: Id<"orgs">,
  owner: Id<"users">,
  publicOrganization: string,
  publicOwner: string,
  scope: { type: "all" } | { type: "stream"; streamId: string },
) {
  return createChangeCursor({
    organizationId: publicOrganization as never,
    ownerUserId: publicOwner as never,
    scope: scope as never,
    position: readChangeCursor(cursor as never, organization as never, owner as never, scope as never),
  })
}
