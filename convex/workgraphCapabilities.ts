import { ExecutionCapabilitiesSchema, isExecutionCapabilityCatalogFresh } from "@claxedo/workgraph/contracts"
import { v } from "convex/values"
import { serviceMutation, serviceQuery } from "./model"
import { requireTrustedWorkGraphTenantSubject } from "./workgraphModel"

const tenantArgs = {
  organization_id: v.id("orgs"),
  owner_subject: v.string(),
}

export const attestForService = serviceMutation({
  args: { ...tenantArgs, capabilities: v.any(), attested_at: v.number() },
  handler: async (ctx, args) => {
    const tenant = await requireTrustedWorkGraphTenantSubject(
      ctx,
      args.service_token,
      args.organization_id,
      args.owner_subject,
    )
    const capabilities = ExecutionCapabilitiesSchema.parse(args.capabilities)
    if (capabilities.organizationId !== String(args.organization_id)) {
      throw new Error("Execution capability organization does not match the attested WorkGraph tenant")
    }
    if (capabilities.ownerUserId !== args.owner_subject) {
      throw new Error("Execution capability owner does not match the attested WorkGraph tenant")
    }
    if (!isExecutionCapabilityCatalogFresh(capabilities, args.attested_at)) {
      throw new Error("Expired execution capabilities cannot be attested")
    }
    const existing = await ctx.db.query("workgraph_execution_capabilities")
      .withIndex("by_tenant", (query: any) => query.eq("organization_id", tenant.organization_id).eq("owner_user_id", tenant.owner_user_id))
      .unique()
    const value = {
      schema_version: 1 as const,
      catalog: capabilities,
      catalog_revision: capabilities.catalogRevision,
      observed_at: capabilities.observedAt,
      expires_at: capabilities.expiresAt,
      attested_at: args.attested_at,
    }
    if (existing) {
      await ctx.db.patch(existing._id, value)
      return { attested: true }
    }
    await ctx.db.insert("workgraph_execution_capabilities", {
      organization_id: tenant.organization_id,
      owner_user_id: tenant.owner_user_id,
      ...value,
    })
    return { attested: true }
  },
})

export const readForService = serviceQuery({
  args: { ...tenantArgs, now: v.number() },
  handler: async (ctx, args) => {
    const tenant = await requireTrustedWorkGraphTenantSubject(
      ctx,
      args.service_token,
      args.organization_id,
      args.owner_subject,
    )
    const snapshot = await ctx.db.query("workgraph_execution_capabilities")
      .withIndex("by_tenant", (query: any) => query.eq("organization_id", tenant.organization_id).eq("owner_user_id", tenant.owner_user_id))
      .unique()
    if (!snapshot) return null
    if (typeof snapshot.catalog_revision !== "string" || typeof snapshot.expires_at !== "number") {
      throw new Error("The execution capability attestation predates the freshness contract")
    }
    if (snapshot.expires_at <= args.now) throw new Error("The execution capability attestation has expired")
    const catalog = ExecutionCapabilitiesSchema.parse(snapshot.catalog)
    if (
      snapshot.catalog_revision !== catalog.catalogRevision ||
      snapshot.observed_at !== catalog.observedAt ||
      snapshot.expires_at !== catalog.expiresAt ||
      !isExecutionCapabilityCatalogFresh(catalog, args.now)
    ) {
      throw new Error("The persisted execution capability attestation is inconsistent or stale")
    }
    return catalog
  },
})
