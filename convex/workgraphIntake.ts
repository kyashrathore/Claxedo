import type { GenericMutationCtx, GenericQueryCtx } from "convex/server"
import {
  IntakeCandidatePageCursorError,
  IntakeCandidatePageSchema,
  createIntakeCandidatePageCursor,
  readIntakeCandidatePageCursor,
} from "@claxedo/workgraph/contracts"
import { ConvexError, v } from "convex/values"
import { serviceMutation, serviceQuery } from "./model"
import { assertWorkGraphOwnerReadable, assertWorkGraphOwnerWritable, requireTrustedWorkGraphTenantSubject } from "./workgraphModel"
import type { DataModel, Doc, Id } from "./_generated/dataModel"
import { initializeAttentionProjection, syncAttentionRecord, syncCandidateTransition } from "./workgraphAttention"
import { appendSystemWorkGraphChange } from "./workgraphCommands"

type ReadCtx = GenericQueryCtx<DataModel>
type WriteCtx = GenericMutationCtx<DataModel>
type Ctx = ReadCtx | WriteCtx

export const readForService = serviceQuery({
  args: { organization_id: v.id("orgs"), owner_subject: v.string(), query: v.any() },
  handler: async (ctx, args) => {
    const tenant = await requireTrustedWorkGraphTenantSubject(ctx, args.service_token, args.organization_id, args.owner_subject)
    return readWorkGraphIntake(ctx, tenant.organization_id as Id<"orgs">, tenant.owner_user_id, args.query)
  },
})

export const executeForService = serviceMutation({
  args: { organization_id: v.id("orgs"), owner_subject: v.string(), operation: v.any() },
  handler: async (ctx, args) => {
    const tenant = await requireTrustedWorkGraphTenantSubject(ctx, args.service_token, args.organization_id, args.owner_subject)
    return applyWorkGraphIntakeOperation(ctx, tenant.organization_id as Id<"orgs">, tenant.owner_user_id, args.operation)
  },
})

export const readWebhookForService = serviceQuery({
  args: { query: v.any() },
  handler: (ctx, args) => readWorkGraphWebhook(ctx, args.query),
})

export const executeWebhookForService = serviceMutation({
  args: { operation: v.any() },
  handler: (ctx, args) => applyWorkGraphWebhookOperation(ctx, args.operation),
})

/** Shared implementations are exported so adapter tests exercise the production state machine. */
export async function readWorkGraphIntake(ctx: ReadCtx, organizationId: Id<"orgs">, ownerUserId: Id<"users">, input: unknown) {
  await assertWorkGraphOwnerReadable(ctx, organizationId, ownerUserId)
  const query = object(input, "intake query")
  const kind = requiredString(query.kind, "query.kind")
  if (kind === "source_views") {
    return {
      sourceViews: (await ctx.db.query("workgraph_source_views")
        .withIndex("by_tenant", (builder) => builder.eq("organization_id", organizationId).eq("owner_user_id", ownerUserId))
        .collect())
        .sort(newestFirst)
        .map(sourceViewDto),
    }
  }
  if (kind === "source_view") {
    const row = await ownedSourceView(ctx, organizationId, ownerUserId, requiredString(query.sourceViewId, "sourceViewId"))
    return row ? sourceViewDto(row) : null
  }
  if (kind === "candidates") {
    const sourceViewId = optionalString(query.sourceViewId, "sourceViewId")
    return {
      candidates: (await ctx.db.query("workgraph_intake_candidates")
        .withIndex("by_tenant", (builder) => builder.eq("organization_id", organizationId).eq("owner_user_id", ownerUserId))
        .collect())
        .filter((row) => !sourceViewId || row.source_view_id === sourceViewId)
        .sort(newestFirst)
        .map(candidateDto),
    }
  }
  if (kind === "candidate_page") {
    const limit = positiveInteger(query.limit, "limit")
    if (limit > 100) throw new Error("Candidate page limit is invalid")
    const sourceViewId = optionalString(query.sourceViewId, "sourceViewId")
    try {
      const after = query.after === undefined
        ? undefined
        : readIntakeCandidatePageCursor(requiredString(query.after, "after"), String(organizationId), String(ownerUserId), sourceViewId)
      const rows = await candidatePageRows(ctx, organizationId, ownerUserId, sourceViewId, after, limit + 1)
      const page = rows.slice(0, limit)
      const hasMore = rows.length > limit
      return IntakeCandidatePageSchema.parse({
        candidates: page.map(candidateDto),
        hasMore,
        ...(hasMore ? {
          nextCursor: createIntakeCandidatePageCursor({
            organizationId: String(organizationId),
            ownerUserId: String(ownerUserId),
            ...(sourceViewId ? { sourceViewId } : {}),
            updatedAt: page.at(-1)!.updated_at,
            candidateId: page.at(-1)!.id,
          }),
        } : {}),
      })
    } catch (error) {
      if (error instanceof IntakeCandidatePageCursorError) {
        throw new ConvexError({ code: error.code, reason: error.reason })
      }
      throw error
    }
  }
  if (kind === "candidate") {
    const row = await ownedCandidate(ctx, organizationId, ownerUserId, requiredString(query.candidateId, "candidateId"))
    return row ? candidateDto(row) : null
  }
  if (kind === "connection") {
    return resolveConnection(
      ctx,
      organizationId,
      ownerUserId,
      requiredString(query.connectionId, "connectionId"),
    )
  }
  throw new Error("Unsupported WorkGraph intake query")
}

export async function applyWorkGraphIntakeOperation(ctx: WriteCtx, organizationId: Id<"orgs">, ownerUserId: Id<"users">, input: unknown) {
  await assertWorkGraphOwnerWritable(ctx, organizationId, ownerUserId)
  const operation = object(input, "intake operation")
  const type = requiredString(operation.type, "operation.type")
  if (type === "create_source_view") return createSourceView(ctx, organizationId, ownerUserId, operation)
  if (type === "update_source_view") return updateSourceView(ctx, organizationId, ownerUserId, operation)
  if (type === "delete_source_view") return deleteSourceView(ctx, organizationId, ownerUserId, operation)
  if (type === "upsert_external") return upsertExternal(ctx, organizationId, ownerUserId, operation)
  if (type === "prepare_stage_candidate") return prepareStageCandidate(ctx, organizationId, ownerUserId, operation)
  if (type === "stage_candidate") return stageCandidate(ctx, organizationId, ownerUserId, operation)
  if (type === "transition_candidate") return transitionCandidate(ctx, organizationId, ownerUserId, operation)
  if (type === "begin_receipt") return beginReceipt(ctx, organizationId, ownerUserId, operation)
  if (type === "complete_receipt") return settleReceipt(ctx, organizationId, ownerUserId, operation, "completed")
  if (type === "fail_receipt") return settleReceipt(ctx, organizationId, ownerUserId, operation, "failed")
  throw new Error("Unsupported WorkGraph intake operation")
}

export async function readWorkGraphWebhook(ctx: ReadCtx, input: unknown) {
  const query = object(input, "webhook query")
  if (requiredString(query.kind, "query.kind") !== "source_views") throw new Error("Unsupported WorkGraph webhook query")
  const limit = requiredNumber(query.limit, "limit")
  if (!Number.isInteger(limit) || limit < 1 || limit > 101) throw new Error("Webhook Source View limit is invalid")
  const connectionId = requiredString(query.connectionId, "connectionId")
  const connection = await ctx.db.query("workgraph_connection_metadata")
    .withIndex("by_connection", (builder) => builder.eq("connection_id", connectionId))
    .unique()
  if (!connection) throw new Error("Webhook Connection metadata is unavailable")
  const memberships = await ctx.db.query("org_memberships")
    .withIndex("by_org_user", (builder) => builder.eq("org_id", connection.organization_id))
    .take(limit)
  const rows = (await Promise.all(memberships.map((membership) => ctx.db.query("workgraph_source_views")
    .withIndex("by_tenant_connection_provider_status", (builder) => builder
      .eq("organization_id", connection.organization_id)
      .eq("owner_user_id", membership.user_id)
      .eq("team_connection_id", connectionId)
      .eq("provider", sourceProvider(query.provider))
      .eq("status", "active"))
    .take(limit)))).flat().slice(0, limit)
  return {
    sourceViews: await Promise.all(rows.map(async (row) => {
      const owner = await ctx.db.get(row.owner_user_id)
      if (!owner?.clerk_subject) throw new Error("Webhook Source View owner subject is unavailable")
      return { ...sourceViewDto(row), ownerUserId: owner.clerk_subject }
    })),
  }
}

export async function applyWorkGraphWebhookOperation(ctx: WriteCtx, input: unknown) {
  const operation = object(input, "webhook operation")
  const type = requiredString(operation.type, "operation.type")
  if (type === "begin_webhook") return beginWebhook(ctx, operation)
  if (type === "complete_webhook") return settleWebhook(ctx, operation, "completed")
  if (type === "fail_webhook") return settleWebhook(ctx, operation, "failed")
  throw new Error("Unsupported WorkGraph webhook operation")
}

async function beginWebhook(ctx: WriteCtx, operation: Record<string, unknown>) {
  const connectionId = requiredString(operation.connectionId, "connectionId")
  const provider = sourceProvider(operation.provider)
  const deliveryId = requiredString(operation.deliveryId, "deliveryId")
  const now = requiredNumber(operation.now, "now")
  const existing = await ctx.db.query("workgraph_webhook_deliveries")
    .withIndex("by_delivery", (builder) => builder.eq("connection_id", connectionId).eq("provider", provider).eq("delivery_id", deliveryId))
    .unique()
  if (existing?.status === "completed") return { state: "completed" as const }
  if (existing?.status === "pending" && (existing.claim_expires_at ?? 0) > now) return { state: "busy" as const }
  const leaseId = crypto.randomUUID()
  if (existing) {
    await ctx.db.patch(existing._id, {
      status: "pending",
      claimed_by: leaseId,
      claim_expires_at: now + 60_000,
      attempt_count: existing.attempt_count + 1,
      updated_at: now,
    })
    return { state: "acquired" as const, leaseId }
  }
  await ctx.db.insert("workgraph_webhook_deliveries", {
    connection_id: connectionId,
    provider,
    delivery_id: deliveryId,
    event_type: requiredString(operation.event, "event"),
    status: "pending",
    claimed_by: leaseId,
    claim_expires_at: now + 60_000,
    attempt_count: 1,
    created_at: now,
    updated_at: now,
  })
  return { state: "acquired" as const, leaseId }
}

async function settleWebhook(ctx: WriteCtx, operation: Record<string, unknown>, status: "completed" | "failed") {
  const row = await ctx.db.query("workgraph_webhook_deliveries")
    .withIndex("by_delivery", (builder) => builder
      .eq("connection_id", requiredString(operation.connectionId, "connectionId"))
      .eq("provider", sourceProvider(operation.provider))
      .eq("delivery_id", requiredString(operation.deliveryId, "deliveryId")))
    .unique()
  if (row?.status === "pending" && row.claimed_by === requiredString(operation.leaseId, "leaseId")) {
    await ctx.db.patch(row._id, { status, claimed_by: undefined, claim_expires_at: undefined, updated_at: requiredNumber(operation.now, "now") })
    return true
  }
  return false
}

async function createSourceView(ctx: WriteCtx, organizationId: Id<"orgs">, ownerUserId: Id<"users">, operation: Record<string, unknown>) {
  const view = object(operation.view, "view")
  const orgId = requiredString(operation.orgId, "orgId") as Id<"orgs">
  if (orgId !== organizationId) throw new Error("Source View organization does not match its WorkGraph tenant")
  if (!await isOrgMember(ctx, ownerUserId, orgId)) throw new Error("WorkGraph owner is not an org member")
  const id = requiredString(view.id, "view.id")
  if (await ownedSourceView(ctx, organizationId, ownerUserId, id)) throw new Error("Source View already exists")
  const provider = sourceProvider(view.provider)
  const connectionId = requiredString(view.teamConnectionId, "view.teamConnectionId")
  const connection = await ctx.db.query("workgraph_connection_metadata")
    .withIndex("by_organization_connection", (builder) => builder
      .eq("organization_id", orgId)
      .eq("connection_id", connectionId))
    .unique()
  if (!connection || connection.status !== "connected" || !connection.capabilities.includes("work-source") ||
    !providerMatches(provider, connection.integration_id)) throw new Error("Source View Connection is unavailable")
  const now = requiredNumber(view.createdAt, "view.createdAt")
  await ensureRoot(ctx, organizationId, ownerUserId, now)
  const row = {
    organization_id: organizationId,
    owner_user_id: ownerUserId,
    id,
    workgraph_id: "workgraph_default",
    team_connection_id: connectionId,
    provider,
    provider_user_id: requiredString(view.providerUserId, "view.providerUserId"),
    filters: sourceFilters(provider, view.filters),
    ...(view.target === undefined ? {} : { target: sourceViewTarget(view.target) }),
    refresh_policy: {},
    sync_policy: syncPolicy(view.syncPolicy),
    status: "active",
    row_version: 1,
    schema_version: 1,
    created_at: now,
    updated_at: requiredNumber(view.updatedAt, "view.updatedAt"),
  }
  await ctx.db.insert("workgraph_source_views", row)
  return sourceViewDto(row)
}

async function updateSourceView(ctx: WriteCtx, organizationId: Id<"orgs">, ownerUserId: Id<"users">, operation: Record<string, unknown>) {
  const row = await ownedSourceView(ctx, organizationId, ownerUserId, requiredString(operation.sourceViewId, "sourceViewId"))
  if (!row) return { ok: false as const, reason: "not_found" as const }
  const expectedVersion = positiveInteger(operation.expectedVersion, "expectedVersion")
  const target = {
    providerUserId: requiredString(operation.providerUserId, "providerUserId"),
    filters: sourceFilters(sourceProvider(row.provider), operation.filters),
    ...((operation.target ?? row.target) === undefined ? {} : { target: sourceViewTarget(operation.target ?? row.target) }),
    syncPolicy: syncPolicy(operation.syncPolicy),
    status: sourceViewStatus(operation.status),
  }
  if (row.row_version !== expectedVersion) {
    if (row.row_version === expectedVersion + 1 && sameSourceView(row, target)) {
      return { ok: true as const, view: sourceViewDto(row) }
    }
    return { ok: false as const, reason: "version_conflict" as const }
  }
  if (target.status === "active") await requireSourceViewConnection(ctx, ownerUserId, row)
  const updated = {
    ...row,
    provider_user_id: target.providerUserId,
    filters: target.filters,
    ...(target.target ? { target: target.target } : {}),
    sync_policy: target.syncPolicy,
    status: target.status,
    row_version: row.row_version + 1,
    updated_at: requiredNumber(operation.updatedAt, "updatedAt"),
  }
  await ctx.db.patch(row._id, updated)
  return { ok: true as const, view: sourceViewDto(updated) }
}

async function deleteSourceView(ctx: WriteCtx, organizationId: Id<"orgs">, ownerUserId: Id<"users">, operation: Record<string, unknown>) {
  const row = await ownedSourceView(ctx, organizationId, ownerUserId, requiredString(operation.sourceViewId, "sourceViewId"))
  if (!row) return { ok: false as const, reason: "not_found" as const }
  if (row.row_version !== positiveInteger(operation.expectedVersion, "expectedVersion")) {
    return { ok: false as const, reason: "version_conflict" as const }
  }
  const candidates = (await ctx.db.query("workgraph_intake_candidates")
    .withIndex("by_tenant", (builder) => builder.eq("organization_id", organizationId).eq("owner_user_id", ownerUserId))
    .filter((builder) => builder.eq(builder.field("organization_id"), organizationId))
    .collect())
    .filter((candidate) => candidate.source_view_id === row.id)
  if (candidates.some((candidate) => candidate.status !== "dismissed")) {
    return { ok: false as const, reason: "in_use" as const }
  }
  const candidateIds = new Set(candidates.map((candidate) => candidate.id))
  const admitted = (await ctx.db.query("workgraph_admission_proposals")
    .withIndex("by_tenant", (builder) => builder.eq("organization_id", organizationId).eq("owner_user_id", ownerUserId))
    .filter((builder) => builder.eq(builder.field("organization_id"), organizationId))
    .collect())
    .some((proposal) => !!proposal.intake_candidate_id && candidateIds.has(proposal.intake_candidate_id))
  if (admitted) return { ok: false as const, reason: "in_use" as const }
  const identities = (await ctx.db.query("workgraph_external_identities")
    .withIndex("by_tenant", (builder) => builder.eq("organization_id", organizationId).eq("owner_user_id", ownerUserId))
    .filter((builder) => builder.eq(builder.field("organization_id"), organizationId))
    .collect())
    .filter((identity) => !!identity.intake_candidate_id && candidateIds.has(identity.intake_candidate_id))
  await Promise.all(identities.map((identity) => ctx.db.delete(identity._id)))
  await Promise.all(candidates.map((candidate) => ctx.db.delete(candidate._id)))
  await ctx.db.delete(row._id)
  return { ok: true as const, view: sourceViewDto(row) }
}

async function upsertExternal(ctx: WriteCtx, organizationId: Id<"orgs">, ownerUserId: Id<"users">, operation: Record<string, unknown>) {
  requiredString(operation.identityKey, "identityKey")
  const input = object(operation.candidate, "candidate")
  if (input.candidateKind !== "external_issue") throw new Error("Only external issue candidates can be upserted")
  const sourceViewId = requiredString(input.sourceViewId, "candidate.sourceViewId")
  const sourceView = await ownedSourceView(ctx, organizationId, ownerUserId, sourceViewId)
  if (!sourceView) throw new Error("Source View not found")
  const provider = sourceProvider(input.provider)
  if (provider !== sourceView.provider) throw new Error("Candidate provider does not match its Source View")
  const externalId = requiredString(input.externalId, "candidate.externalId")
  const existingIdentity = await ctx.db.query("workgraph_external_identities")
    .withIndex("by_tenant_external", (builder) => builder
      .eq("organization_id", organizationId)
      .eq("owner_user_id", ownerUserId)
      .eq("provider", provider)
      .eq("team_connection_id", sourceView.team_connection_id)
      .eq("external_id", externalId))
    .filter((builder) => builder.eq(builder.field("organization_id"), organizationId))
    .unique()
  const now = requiredNumber(input.updatedAt, "candidate.updatedAt")
  const normalized = externalNormalized(input)
  if (existingIdentity?.intake_candidate_id) {
    const existing = await ownedCandidate(ctx, organizationId, ownerUserId, existingIdentity.intake_candidate_id)
    if (!existing || existing.candidate_kind !== "external_issue") throw new Error("External identity resolved to an invalid candidate")
    const existingNormalized = object(existing.normalized, "candidate.normalized")
    const saved = existing.status === "unorganized" && existingNormalized.admissionDraft === undefined
      ? {
          ...existing,
          source_view_id: sourceViewId,
          title: requiredString(input.title, "candidate.title"),
          body: string(input.body, "candidate.body"),
          normalized,
          observed_revision: optionalString(input.observedRevision, "candidate.observedRevision"),
          row_version: existing.row_version + 1,
          updated_at: now,
        }
      : existing
    if (saved !== existing) {
      await ctx.db.patch(existing._id, saved)
      await syncCandidateTransition(ctx, existing, saved)
      await appendIntakeCandidateChange(ctx, saved)
    }
    await ctx.db.patch(existingIdentity._id, {
      external_key: optionalString(input.externalKey, "candidate.externalKey"),
      external_url: optionalString(input.externalUrl, "candidate.externalUrl"),
      observed_revision: optionalString(input.observedRevision, "candidate.observedRevision"),
      updated_at: now,
    })
    return { candidate: candidateDto(saved), created: false as const }
  }
  const createdAt = requiredNumber(input.createdAt, "candidate.createdAt")
  const candidate = {
    organization_id: organizationId,
    owner_user_id: ownerUserId,
    id: requiredString(input.id, "candidate.id"),
    workgraph_id: "workgraph_default",
    source_view_id: sourceViewId,
    candidate_kind: "external_issue" as const,
    title: requiredString(input.title, "candidate.title"),
    body: string(input.body, "candidate.body"),
    normalized,
    status: "unorganized" as const,
    observed_revision: optionalString(input.observedRevision, "candidate.observedRevision"),
    row_version: 1,
    schema_version: 1,
    created_at: createdAt,
    updated_at: now,
  }
  await ctx.db.insert("workgraph_intake_candidates", candidate)
  await syncCandidateTransition(ctx, undefined, candidate)
  await appendIntakeCandidateChange(ctx, candidate)
  const identity = {
    intake_candidate_id: candidate.id,
    external_key: optionalString(input.externalKey, "candidate.externalKey"),
    external_url: optionalString(input.externalUrl, "candidate.externalUrl"),
    observed_revision: optionalString(input.observedRevision, "candidate.observedRevision"),
    updated_at: now,
  }
  if (existingIdentity) await ctx.db.patch(existingIdentity._id, identity)
  if (!existingIdentity) await ctx.db.insert("workgraph_external_identities", {
    organization_id: organizationId,
    owner_user_id: ownerUserId,
    id: `identity_${candidate.id}`,
    ...identity,
    provider,
    team_connection_id: sourceView.team_connection_id,
    external_id: externalId,
    metadata: {},
    schema_version: 1,
    created_at: createdAt,
  })
  return { candidate: candidateDto(candidate), created: true as const }
}

async function prepareStageCandidate(ctx: WriteCtx, organizationId: Id<"orgs">, ownerUserId: Id<"users">, operation: Record<string, unknown>) {
  const row = await requireCandidate(ctx, organizationId, ownerUserId, operation)
  if (row.status !== "unorganized" && row.status !== "staged") throw new Error("Candidate cannot be staged")
  const normalized = object(row.normalized, "candidate.normalized")
  const provided = object(operation.draft, "draft")
  const draft = normalized.admissionDraft === undefined
    ? { title: requiredString(provided.title, "draft.title"), content: requiredString(provided.content, "draft.content") }
    : stageDraft(normalized.admissionDraft)
  const saved = normalized.admissionDraft === undefined
    ? { ...row, normalized: { ...normalized, admissionDraft: draft }, row_version: row.row_version + 1, updated_at: requiredNumber(operation.now, "now") }
    : row
  if (saved !== row) {
    await ctx.db.patch(row._id, saved)
    await syncCandidateTransition(ctx, row, saved)
  }
  return { candidate: candidateDto(saved), draft }
}

async function stageCandidate(ctx: WriteCtx, organizationId: Id<"orgs">, ownerUserId: Id<"users">, operation: Record<string, unknown>) {
  const row = await requireCandidate(ctx, organizationId, ownerUserId, operation)
  if (row.status !== "unorganized" && row.status !== "staged") throw new Error("Candidate cannot be staged")
  const normalized = object(row.normalized, "candidate.normalized")
  const draft = stageDraft(normalized.admissionDraft)
  const source = sourceReference(operation.source)
  if (await crypto.subtle.digest("SHA-256", new TextEncoder().encode(draft.content)).then(hex) !== source.contentHash) {
    throw new Error("Candidate source does not match its frozen intake evidence")
  }
  const proposalId = requiredString(operation.proposalId, "proposalId")
  const proposal = await ctx.db.query("workgraph_admission_proposals")
    .withIndex("by_tenant_id", (builder) => builder.eq("organization_id", organizationId).eq("owner_user_id", ownerUserId).eq("id", proposalId))
    .filter((builder) => builder.eq(builder.field("organization_id"), organizationId))
    .unique()
  if (!proposal || !["planning", "planning_failed", "proposed"].includes(proposal.state) || !sameSource(proposal.source, source)) {
    throw new Error("Admission proposal does not match the candidate source")
  }
  if (proposal.intake_candidate_id && proposal.intake_candidate_id !== row.id) throw new Error("Admission proposal is already bound to another candidate")
  const saved = {
    ...row,
    status: "staged" as const,
    normalized: { ...normalized, source, admissionProposalId: proposalId },
    row_version: row.row_version + 1,
    updated_at: requiredNumber(operation.now, "now"),
  }
  await ctx.db.patch(proposal._id, { intake_candidate_id: row.id, updated_at: saved.updated_at })
  await ctx.db.patch(row._id, saved)
  await syncAttentionRecord(ctx, "workgraph_admission_proposals", { ...proposal, intake_candidate_id: row.id, updated_at: saved.updated_at })
  await syncCandidateTransition(ctx, row, saved)
  await appendIntakeCandidateChange(ctx, saved)
  return candidateDto(saved)
}

async function transitionCandidate(ctx: WriteCtx, organizationId: Id<"orgs">, ownerUserId: Id<"users">, operation: Record<string, unknown>) {
  const row = await ownedCandidate(ctx, organizationId, ownerUserId, requiredString(operation.candidateId, "candidateId"))
  if (!row) return { ok: false as const, reason: "not_found" as const }
  const expectedVersion = positiveInteger(operation.expectedVersion, "expectedVersion")
  const from = candidateTransitionState(operation.from, "from")
  const to = candidateTransitionState(operation.to, "to")
  if (!((from === "unorganized" && to === "dismissed") || (from === "dismissed" && to === "unorganized"))) {
    throw new Error("Candidate transition is invalid")
  }
  if (row.row_version !== expectedVersion) {
    if (row.row_version === expectedVersion + 1 && row.status === to) {
      return { ok: true as const, candidate: candidateDto(row) }
    }
    return { ok: false as const, reason: "version_conflict" as const }
  }
  if (row.status !== from) return { ok: false as const, reason: "invalid_state" as const }
  const updated = {
    ...row,
    status: to,
    row_version: row.row_version + 1,
    updated_at: requiredNumber(operation.updatedAt, "updatedAt"),
  }
  await ctx.db.patch(row._id, updated)
  await syncCandidateTransition(ctx, row, updated)
  await appendIntakeCandidateChange(ctx, updated)
  return { ok: true as const, candidate: candidateDto(updated) }
}

export function appendIntakeCandidateChange(ctx: WriteCtx, candidate: any) {
  return appendSystemWorkGraphChange(ctx, {
    organizationId: String(candidate.organization_id),
    ownerUserId: String(candidate.owner_user_id),
    operationId: `intake:${candidate.id}:${candidate.row_version}:${candidate.status}`,
    eventId: `event_${crypto.randomUUID()}`,
    changeId: `change_${crypto.randomUUID()}`,
    resourceType: "workgraph",
    resourceId: "workgraph_default",
    changeType: "intake_candidate_changed",
    payload: { candidateId: candidate.id, candidateVersion: candidate.row_version, state: candidate.status },
    actorId: "workgraph_intake",
    snapshotRelevant: false,
    now: candidate.updated_at,
  })
}

async function beginReceipt(ctx: WriteCtx, organizationId: Id<"orgs">, ownerUserId: Id<"users">, operation: Record<string, unknown>) {
  const key = requiredString(operation.key, "key")
  const now = requiredNumber(operation.now, "now")
  const existing = await ctx.db.query("workgraph_outbox")
    .withIndex("by_tenant_idempotency", (builder) => builder.eq("organization_id", organizationId).eq("owner_user_id", ownerUserId).eq("idempotency_key", key))
    .filter((builder) => builder.eq(builder.field("organization_id"), organizationId))
    .unique()
  if (existing?.status === "completed") return { state: "completed" as const }
  if (existing?.status === "pending" && (existing.claim_expires_at ?? 0) > now) return { state: "busy" as const }
  const leaseId = crypto.randomUUID()
  if (existing) {
    await ctx.db.patch(existing._id, { status: "pending", claimed_by: leaseId, claim_expires_at: now + 60_000, updated_at: now })
    return { state: "acquired" as const, leaseId }
  }
  await ctx.db.insert("workgraph_outbox", {
    organization_id: organizationId,
    owner_user_id: ownerUserId,
    id: `intake_receipt_${crypto.randomUUID()}`,
    operation_id: `intake_sync_${crypto.randomUUID()}`,
    effect_type: "intake_external_sync",
    idempotency_key: key,
    payload: {
      candidateId: requiredString(operation.candidateId, "candidateId"),
      effect: effect(operation.effect),
    },
    status: "pending",
    available_at: now,
    attempt_count: 0,
    claimed_by: leaseId,
    claim_expires_at: now + 60_000,
    schema_version: 1,
    created_at: now,
    updated_at: now,
  })
  return { state: "acquired" as const, leaseId }
}

async function settleReceipt(ctx: WriteCtx, organizationId: Id<"orgs">, ownerUserId: Id<"users">, operation: Record<string, unknown>, status: "completed" | "failed") {
  const row = await ctx.db.query("workgraph_outbox")
    .withIndex("by_tenant_idempotency", (builder) => builder
      .eq("organization_id", organizationId)
      .eq("owner_user_id", ownerUserId)
      .eq("idempotency_key", requiredString(operation.key, "key")))
    .filter((builder) => builder.eq(builder.field("organization_id"), organizationId))
    .unique()
  if (row?.status === "pending" && row.claimed_by === requiredString(operation.leaseId, "leaseId")) {
    await ctx.db.patch(row._id, {
      status,
      claimed_by: undefined,
      claim_expires_at: undefined,
      updated_at: requiredNumber(operation.now, "now"),
    })
  }
}

async function resolveConnection(ctx: ReadCtx, organizationId: Id<"orgs">, ownerUserId: Id<"users">, connectionId: string) {
  if (!await isOrgMember(ctx, ownerUserId, organizationId)) return null
  const row = await ctx.db.query("workgraph_connection_metadata")
    .withIndex("by_organization_connection", (builder) => builder
      .eq("organization_id", organizationId)
      .eq("connection_id", connectionId))
    .unique()
  if (!row) return null
  return {
    id: row.connection_id,
    ownerUserId: String(ownerUserId),
    orgId: String(organizationId),
    integrationId: row.integration_id,
    capabilities: row.capabilities,
    status: row.status,
    ...(row.token_type ? { tokenType: row.token_type } : {}),
    ...(row.fields ? { fields: row.fields } : {}),
    ...(row.account_label ? { accountLabel: row.account_label } : {}),
  }
}

async function ensureRoot(ctx: WriteCtx, organizationId: Id<"orgs">, ownerUserId: Id<"users">, now: number) {
  if (await ownedRoot(ctx, organizationId, ownerUserId)) return
  await ctx.db.insert("workgraphs", {
    organization_id: organizationId,
    owner_user_id: ownerUserId,
    id: "workgraph_default",
    defaults: {},
    provenance: { actor: { type: "system", id: "workgraph_intake" } },
    row_version: 1,
    schema_version: 1,
    created_at: now,
    updated_at: now,
  })
  await initializeAttentionProjection(ctx, String(organizationId), String(ownerUserId), now)
}

async function requireCandidate(ctx: WriteCtx, organizationId: Id<"orgs">, ownerUserId: Id<"users">, operation: Record<string, unknown>) {
  const row = await ownedCandidate(ctx, organizationId, ownerUserId, requiredString(operation.candidateId, "candidateId"))
  if (!row) throw new Error("Candidate not found")
  return row
}

function ownedRoot(ctx: Ctx, organizationId: Id<"orgs">, ownerUserId: Id<"users">) {
  return ctx.db.query("workgraphs")
    .withIndex("by_tenant_id", (builder) => builder.eq("organization_id", organizationId).eq("owner_user_id", ownerUserId).eq("id", "workgraph_default"))
    .unique()
}

function ownedSourceView(ctx: Ctx, organizationId: Id<"orgs">, ownerUserId: Id<"users">, id: string) {
  return ctx.db.query("workgraph_source_views")
    .withIndex("by_tenant_id", (builder) => builder.eq("organization_id", organizationId).eq("owner_user_id", ownerUserId).eq("id", id))
    .unique()
}

function ownedCandidate(ctx: Ctx, organizationId: Id<"orgs">, ownerUserId: Id<"users">, id: string) {
  return ctx.db.query("workgraph_intake_candidates")
    .withIndex("by_tenant", (builder) => builder.eq("organization_id", organizationId).eq("owner_user_id", ownerUserId))
    .filter((builder) => builder.eq(builder.field("id"), id))
    .unique()
}

async function candidatePageRows(
  ctx: ReadCtx,
  organizationId: Id<"orgs">,
  ownerUserId: Id<"users">,
  sourceViewId: string | undefined,
  after: Readonly<{ updatedAt: number; candidateId: string }> | undefined,
  limit: number,
) {
  const index = sourceViewId ? "by_tenant_status_source_updated_id" as const : "by_tenant_status_updated_id" as const
  const query = () => sourceViewId
    ? ctx.db.query("workgraph_intake_candidates").withIndex(index, (builder) => builder
        .eq("organization_id", organizationId)
        .eq("owner_user_id", ownerUserId)
        .eq("status", "unorganized")
        .eq("source_view_id", sourceViewId))
    : ctx.db.query("workgraph_intake_candidates").withIndex(index, (builder) => builder
        .eq("organization_id", organizationId)
        .eq("owner_user_id", ownerUserId)
        .eq("status", "unorganized"))
  if (!after) return query().filter((builder) => builder.eq(builder.field("organization_id"), organizationId)).order("desc").take(limit)
  const sameTimestamp = await (sourceViewId
    ? ctx.db.query("workgraph_intake_candidates").withIndex(index, (builder) => builder
        .eq("organization_id", organizationId)
        .eq("owner_user_id", ownerUserId)
        .eq("status", "unorganized")
        .eq("source_view_id", sourceViewId)
        .eq("updated_at", after.updatedAt)
        .lt("id", after.candidateId))
    : ctx.db.query("workgraph_intake_candidates").withIndex(index, (builder) => builder
        .eq("organization_id", organizationId)
        .eq("owner_user_id", ownerUserId)
        .eq("status", "unorganized")
        .eq("updated_at", after.updatedAt)
        .lt("id", after.candidateId)))
    .filter((builder) => builder.eq(builder.field("organization_id"), organizationId))
    .order("desc")
    .take(limit)
  if (sameTimestamp.length === limit) return sameTimestamp
  const older = await (sourceViewId
    ? ctx.db.query("workgraph_intake_candidates").withIndex(index, (builder) => builder
        .eq("organization_id", organizationId)
        .eq("owner_user_id", ownerUserId)
        .eq("status", "unorganized")
        .eq("source_view_id", sourceViewId)
        .lt("updated_at", after.updatedAt))
    : ctx.db.query("workgraph_intake_candidates").withIndex(index, (builder) => builder
        .eq("organization_id", organizationId)
        .eq("owner_user_id", ownerUserId)
        .eq("status", "unorganized")
        .lt("updated_at", after.updatedAt)))
    .filter((builder) => builder.eq(builder.field("organization_id"), organizationId))
    .order("desc")
    .take(limit - sameTimestamp.length)
  return [...sameTimestamp, ...older]
}

async function isOrgMember(ctx: Ctx, ownerUserId: Id<"users">, orgId: Id<"orgs">) {
  return !!await ctx.db.query("org_memberships")
    .withIndex("by_org_user", (builder) => builder.eq("org_id", orgId).eq("user_id", ownerUserId))
    .unique()
}

function sourceViewDto(row: Pick<Doc<"workgraph_source_views">, "id" | "owner_user_id" | "team_connection_id" | "provider" | "provider_user_id" | "filters" | "target" | "sync_policy" | "status" | "row_version" | "created_at" | "updated_at">) {
  return {
    id: row.id,
    ownerUserId: String(row.owner_user_id),
    version: row.row_version,
    teamConnectionId: row.team_connection_id,
    provider: row.provider,
    providerUserId: row.provider_user_id,
    filters: row.filters,
    ...(row.target ? { target: row.target } : {}),
    syncPolicy: row.sync_policy,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function candidateDto(row: Pick<Doc<"workgraph_intake_candidates">, "id" | "owner_user_id" | "source_view_id" | "candidate_kind" | "title" | "body" | "normalized" | "status" | "observed_revision" | "row_version" | "created_at" | "updated_at">) {
  const normalized = object(row.normalized, "candidate.normalized")
  const common = {
    id: row.id,
    ownerUserId: String(row.owner_user_id),
    version: row.row_version,
    title: row.title,
    body: row.body,
    ...(row.observed_revision ? { observedRevision: row.observed_revision } : {}),
    state: row.status,
    ...admission(normalized),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
  if (row.candidate_kind === "session") {
    return {
      ...common,
      candidateKind: "session" as const,
      sessionId: requiredString(normalized.sessionId, "candidate.sessionId"),
      ...(normalized.execution ? { execution: normalized.execution } : {}),
    }
  }
  if (row.candidate_kind !== "external_issue" || !row.source_view_id) throw new Error("Unsupported intake candidate kind")
  return {
    ...common,
    candidateKind: "external_issue" as const,
    sourceViewId: row.source_view_id,
    provider: sourceProvider(normalized.provider),
    externalId: requiredString(normalized.externalId, "candidate.externalId"),
    ...(optionalString(normalized.externalKey, "candidate.externalKey") ? { externalKey: normalized.externalKey as string } : {}),
    ...(optionalString(normalized.externalUrl, "candidate.externalUrl") ? { externalUrl: normalized.externalUrl as string } : {}),
    externalStatus: requiredString(normalized.externalStatus, "candidate.externalStatus"),
  }
}

function externalNormalized(input: Record<string, unknown>) {
  return {
    provider: sourceProvider(input.provider),
    externalId: requiredString(input.externalId, "candidate.externalId"),
    ...(optionalString(input.externalKey, "candidate.externalKey") ? { externalKey: input.externalKey } : {}),
    ...(optionalString(input.externalUrl, "candidate.externalUrl") ? { externalUrl: input.externalUrl } : {}),
    externalStatus: requiredString(input.externalStatus, "candidate.externalStatus"),
  }
}

function sourceFilters(provider: "github" | "linear" | "jira", input: unknown) {
  const filters = object(input, "filters")
  const allowed = provider === "github" ? ["repo", "state", "labels"] : provider === "linear" ? ["team"] : ["jql"]
  return Object.fromEntries(Object.entries(filters).flatMap(([rawKey, rawValue]) => {
    const key = rawKey.trim()
    if (!allowed.includes(key)) throw new Error(`Unsupported ${provider} Source View filter`)
    const value = requiredString(rawValue, `filters.${key}`)
    if (secretKey(key) || secretValue(value)) throw new Error("Source View filters cannot contain credential material")
    return [[key, value]]
  }))
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return value as Record<string, unknown>
}

function string(value: unknown, name: string) {
  if (typeof value !== "string") throw new Error(`${name} must be a string`)
  return value
}

function requiredString(value: unknown, name: string) {
  const result = string(value, name).trim()
  if (!result) throw new Error(`${name} is required`)
  return result
}

function optionalString(value: unknown, name: string) {
  if (value === undefined || value === null) return undefined
  return requiredString(value, name)
}

function requiredNumber(value: unknown, name: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`)
  return value
}

function positiveInteger(value: unknown, name: string) {
  const result = requiredNumber(value, name)
  if (!Number.isInteger(result) || result < 1) throw new Error(`${name} must be a positive integer`)
  return result
}

function sourceProvider(value: unknown) {
  if (value === "github" || value === "linear" || value === "jira") return value
  throw new Error("Unsupported Source View provider")
}

function syncPolicy(value: unknown) {
  if (value === "silent" || value === "announce" || value === "full") return value
  throw new Error("Unsupported Source View sync policy")
}

function sourceViewStatus(value: unknown): "active" | "paused" {
  if (value === "active" || value === "paused") return value
  throw new Error("Unsupported Source View status")
}

function candidateTransitionState(value: unknown, name: string): "unorganized" | "dismissed" {
  if (value === "unorganized" || value === "dismissed") return value
  throw new Error(`Unsupported Candidate ${name} state`)
}

function effect(value: unknown) {
  if (value === "announce" || value === "full") return value
  throw new Error("Unsupported intake sync effect")
}

function providerMatches(provider: string, integration: string) {
  return provider === integration || (provider === "jira" && integration === "atlassian")
}

async function requireSourceViewConnection(
  ctx: WriteCtx,
  ownerUserId: Id<"users">,
  view: Pick<Doc<"workgraph_source_views">, "organization_id" | "team_connection_id" | "provider">,
) {
  if (!await isOrgMember(ctx, ownerUserId, view.organization_id)) throw new Error("Source View Connection is unavailable")
  const connection = await ctx.db.query("workgraph_connection_metadata")
    .withIndex("by_organization_connection", (builder) => builder
      .eq("organization_id", view.organization_id)
      .eq("connection_id", view.team_connection_id))
    .unique()
  if (!connection || connection.status !== "connected" || !connection.capabilities.includes("work-source") ||
    !providerMatches(view.provider, connection.integration_id)) throw new Error("Source View Connection is unavailable")
}

function sameSourceView(
  view: Pick<Doc<"workgraph_source_views">, "provider_user_id" | "filters" | "target" | "sync_policy" | "status">,
  input: Readonly<{ providerUserId: string; filters: Record<string, string>; target?: unknown; syncPolicy: string; status: string }>,
) {
  const filters = object(view.filters, "Source View filters")
  return view.provider_user_id === input.providerUserId
    && view.sync_policy === input.syncPolicy
    && view.status === input.status
    && JSON.stringify(view.target) === JSON.stringify(input.target)
    && Object.keys(filters).length === Object.keys(input.filters).length
    && Object.entries(filters).every(([key, value]) => input.filters[key] === value)
}

function sourceViewTarget(value: unknown) {
  const target = object(value, "Source View target")
  const environment = object(target.environment, "Source View target environment")
  const repository = object(target.repository, "Source View target repository")
  const kind = requiredString(environment.kind, "Source View target environment kind")
  const baseRevision = requiredString(repository.baseRevision, "Source View target base revision")
  if (kind === "local_worktree") {
    return {
      environment: { kind, directory: requiredString(environment.directory, "Source View target project directory") },
      repository: {
        ...(repository.remoteUrl === undefined ? {} : { remoteUrl: requiredUrl(repository.remoteUrl, "Source View target repository URL") }),
        baseRevision,
      },
    }
  }
  if (kind !== "hosted_workspace") throw new Error("Source View target environment is unsupported")
  const repositoryUrl = requiredUrl(environment.repositoryUrl, "Source View target repository URL")
  return {
    environment: { kind, repositoryUrl },
    repository: {
      remoteUrl: repository.remoteUrl === undefined ? repositoryUrl : requiredUrl(repository.remoteUrl, "Source View target remote URL"),
      baseRevision,
    },
  }
}

function requiredUrl(value: unknown, name: string) {
  const result = requiredString(value, name)
  try {
    const url = new URL(result)
    if (url.username || url.password || secretValue(result)) throw new Error()
    return url.toString()
  } catch {
    throw new Error(`${name} must be a credential-free URL`)
  }
}

function admission(value: unknown) {
  const normalized = object(value, "candidate.normalized")
  const proposalId = optionalString(normalized.admissionProposalId, "candidate.admissionProposalId")
  return {
    ...(normalized.source === undefined ? {} : { source: sourceReference(normalized.source) }),
    ...(proposalId ? { admissionProposalId: proposalId } : {}),
  }
}

function stageDraft(value: unknown) {
  const draft = object(value, "candidate.admissionDraft")
  return { title: requiredString(draft.title, "draft.title"), content: requiredString(draft.content, "draft.content") }
}

function sourceReference(value: unknown) {
  const source = object(value, "source")
  return {
    workSourceId: requiredString(source.workSourceId ?? source.work_source_id, "source.workSourceId"),
    revisionId: requiredString(source.revisionId ?? source.revision_id, "source.revisionId"),
    contentHash: requiredString(source.contentHash ?? source.content_hash, "source.contentHash"),
  }
}

function sameSource(left: unknown, right: ReturnType<typeof sourceReference>) {
  if (!left) return false
  const source = sourceReference(left)
  return source.workSourceId === right.workSourceId && source.revisionId === right.revisionId && source.contentHash === right.contentHash
}

function hex(buffer: ArrayBuffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

function newestFirst(left: { updated_at: number; id: string }, right: { updated_at: number; id: string }) {
  return right.updated_at - left.updated_at || left.id.localeCompare(right.id)
}

function secretKey(key: string) {
  return /credential|password|secret|token|authorization|cookie/i.test(key)
}

function secretValue(value: string) {
  return /^(?:basic|bearer)\s+\S+/i.test(value) || /(?:token|api[_-]?key|password|secret|authorization)\s*[:=]\s*\S+/i.test(value)
}
