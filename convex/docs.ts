import { v } from "convex/values"
import { authorizeProjectForUser, projectByPublicId, serviceMutation, upsertServiceUser } from "./model"

const serviceUser = v.object({
  token_identifier: v.string(),
  subject: v.optional(v.string()),
  issuer: v.optional(v.string()),
  email: v.optional(v.string()),
  name: v.optional(v.string()),
  image_url: v.optional(v.string()),
})
const authorType = v.union(v.literal("user"), v.literal("agent"), v.literal("system"))
const scope = {
  user: serviceUser,
  organization_id: v.id("orgs"),
}
const content = {
  ...scope,
  project_id: v.string(),
  title: v.string(),
  markdown: v.string(),
  content_hash: v.string(),
  authored_by_type: authorType,
  authored_by_id: v.string(),
  authored_at: v.number(),
  document_id: v.string(),
  revision_id: v.string(),
}

export const createForService = serviceMutation({
  args: content,
  handler: async (ctx, args) => {
    const access = await projectAccess(ctx, args, "write")
    if (!access) return notFound()
    const invalid = await invalidContent(args)
    if (invalid) return invalid
    if ((await documentById(ctx, args.document_id)) || (await revisionById(ctx, args.document_id, args.revision_id))) {
      return notFound()
    }
    await ctx.db.insert("documents", {
      document_id: args.document_id,
      organization_id: access.project.org_id,
      project_id: args.project_id,
      title: args.title,
      head_revision_id: args.revision_id,
      created_at: args.authored_at,
      updated_at: args.authored_at,
    })
    await ctx.db.insert("document_revisions", {
      revision_id: args.revision_id,
      document_id: args.document_id,
      revision_number: 1,
      title: args.title,
      markdown: args.markdown,
      content_hash: args.content_hash.toLowerCase(),
      authored_at: args.authored_at,
      authored_by_type: args.authored_by_type,
      authored_by_id: args.authored_by_id,
      created_at: args.authored_at,
    })
    return {
      ok: true as const,
      revision: await requireRevision(ctx, args.document_id, args.revision_id, args.project_id),
    }
  },
})

export const appendRevisionForService = serviceMutation({
  args: {
    ...content,
    expected_parent_revision_id: v.string(),
  },
  handler: async (ctx, args) => {
    const access = await projectAccess(ctx, args, "write")
    if (!access) return notFound()
    const invalid = await invalidContent(args)
    if (invalid) return invalid
    const document = await tenantDocument(ctx, args.organization_id, args.project_id, args.document_id)
    if (!document) return notFound()
    if (document.head_revision_id !== args.expected_parent_revision_id) {
      return conflict(document.head_revision_id)
    }
    const parent = await revisionById(ctx, document.document_id, document.head_revision_id)
    if (!parent || (await revisionById(ctx, document.document_id, args.revision_id))) return notFound()
    await ctx.db.insert("document_revisions", {
      revision_id: args.revision_id,
      document_id: document.document_id,
      revision_number: parent.revision_number + 1,
      parent_revision_id: parent.revision_id,
      title: args.title,
      markdown: args.markdown,
      content_hash: args.content_hash.toLowerCase(),
      authored_at: args.authored_at,
      authored_by_type: args.authored_by_type,
      authored_by_id: args.authored_by_id,
      created_at: args.authored_at,
    })
    await ctx.db.patch(document._id, {
      title: args.title,
      head_revision_id: args.revision_id,
      updated_at: args.authored_at,
    })
    return {
      ok: true as const,
      revision: await requireRevision(ctx, document.document_id, args.revision_id, args.project_id),
    }
  },
})

export const listForService = serviceMutation({
  args: {
    ...scope,
    project_id: v.string(),
  },
  handler: async (ctx, args) => {
    if (!(await projectAccess(ctx, args, "read"))) return notFound()
    const documents = await ctx.db
      .query("documents")
      .withIndex("by_tenant_document", (query: any) =>
        query.eq("organization_id", args.organization_id).eq("project_id", args.project_id),
      )
      .collect()
    return {
      ok: true as const,
      documents: documents
        .map(documentDto)
        .sort((left, right) => right.updatedAt - left.updatedAt || left.documentId.localeCompare(right.documentId)),
    }
  },
})

export const findForService = serviceMutation({
  args: {
    ...scope,
    document_id: v.string(),
  },
  handler: async (ctx, args) => {
    const document = await documentById(ctx, args.document_id)
    if (!document || String(document.organization_id) !== String(args.organization_id)) {
      return { ok: true as const, document: null }
    }
    if (!(await projectAccess(ctx, { ...args, project_id: document.project_id }, "read"))) {
      return { ok: true as const, document: null }
    }
    return {
      ok: true as const,
      document: documentDto(document),
    }
  },
})

export const getRevisionForService = serviceMutation({
  args: {
    ...scope,
    project_id: v.string(),
    document_id: v.string(),
    revision_id: v.string(),
  },
  handler: async (ctx, args) => {
    if (!(await projectAccess(ctx, args, "read"))) return notFound()
    const document = await tenantDocument(ctx, args.organization_id, args.project_id, args.document_id)
    const revision = document ? await revisionById(ctx, document.document_id, args.revision_id) : undefined
    if (!document || !revision) return notFound()
    return { ok: true as const, revision: revisionDto(document.project_id, revision) }
  },
})

export const getHeadRevisionForService = serviceMutation({
  args: {
    ...scope,
    project_id: v.string(),
    document_id: v.string(),
  },
  handler: async (ctx, args) => {
    if (!(await projectAccess(ctx, args, "read"))) return notFound()
    const document = await tenantDocument(ctx, args.organization_id, args.project_id, args.document_id)
    const revision = document ? await revisionById(ctx, document.document_id, document.head_revision_id) : undefined
    if (!document || !revision) return notFound()
    return { ok: true as const, revision: revisionDto(document.project_id, revision) }
  },
})

async function projectAccess(
  ctx: any,
  args: { user: Parameters<typeof upsertServiceUser>[1]; organization_id: unknown; project_id: string },
  action: "read" | "write",
) {
  const project = await projectByPublicId(ctx.db, args.project_id)
  if (!project || String(project.org_id) !== String(args.organization_id)) return
  const user = await upsertServiceUser(ctx, args.user)
  if (!(await authorizeProjectForUser(ctx, project, user, action))) return
  return { project, user }
}

async function invalidContent(args: {
  user: { subject?: string }
  authored_by_type: "user" | "agent" | "system"
  authored_by_id: string
  markdown: string
  content_hash: string
}) {
  if (args.authored_by_type !== "user" || !args.user.subject || args.authored_by_id !== args.user.subject) {
    return notFound()
  }
  if ((await sha256(args.markdown)) === args.content_hash.toLowerCase()) return
  return {
    ok: false as const,
    code: "document_content_hash_mismatch" as const,
    message: "Document content does not match its declared hash",
  }
}

async function documentById(ctx: any, documentId: string) {
  return await ctx.db
    .query("documents")
    .withIndex("by_document_id", (query: any) => query.eq("document_id", documentId))
    .unique()
}

async function tenantDocument(ctx: any, organizationId: unknown, projectId: string, documentId: string) {
  return await ctx.db
    .query("documents")
    .withIndex("by_tenant_document", (query: any) =>
      query.eq("organization_id", organizationId).eq("project_id", projectId).eq("document_id", documentId),
    )
    .unique()
}

async function revisionById(ctx: any, documentId: string, revisionId: string) {
  return await ctx.db
    .query("document_revisions")
    .withIndex("by_document_revision", (query: any) =>
      query.eq("document_id", documentId).eq("revision_id", revisionId),
    )
    .unique()
}

async function requireRevision(ctx: any, documentId: string, revisionId: string, projectId: string) {
  const revision = await revisionById(ctx, documentId, revisionId)
  if (!revision) throw new Error("Document revision write was not visible")
  return revisionDto(projectId, revision)
}

function revisionDto(projectId: string, revision: any) {
  return {
    projectId,
    documentId: revision.document_id,
    documentTitle: revision.title,
    revisionId: revision.revision_id,
    revisionNumber: revision.revision_number,
    ...(revision.parent_revision_id ? { parentRevisionId: revision.parent_revision_id } : {}),
    markdown: revision.markdown,
    contentHash: revision.content_hash,
    authoredAt: revision.authored_at,
    authoredBy: { type: revision.authored_by_type, id: revision.authored_by_id },
  }
}

function documentDto(document: {
  document_id: string
  project_id: string
  title: string
  head_revision_id: string
  created_at: number
  updated_at: number
}) {
  return {
    documentId: document.document_id,
    projectId: document.project_id,
    title: document.title,
    headRevisionId: document.head_revision_id,
    createdAt: document.created_at,
    updatedAt: document.updated_at,
  }
}

function notFound() {
  return { ok: false as const, code: "document_not_found" as const, message: "Document revision not found" }
}

function conflict(currentRevisionId: string) {
  return {
    ok: false as const,
    code: "document_revision_conflict" as const,
    message: "Document head changed",
    currentRevisionId,
  }
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}
