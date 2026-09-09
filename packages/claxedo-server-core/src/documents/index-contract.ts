import { z } from "zod"

const NonBlankStringSchema = z.string().refine((value) => Boolean(value.trim()))

const DocumentIndexCommonSchema = z.object({
  id: NonBlankStringSchema,
  org_id: NonBlankStringSchema,
  project_id: NonBlankStringSchema,
  display_name: NonBlankStringSchema,
  placement_kind: z.enum(["local", "hosted"]),
  placement_id: NonBlankStringSchema,
  status: NonBlankStringSchema,
  session_id: NonBlankStringSchema.nullable(),
  archived_at: z.string().datetime().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  last_opened_at: z.string().datetime().nullable(),
  last_known_file_version: NonBlankStringSchema.nullable(),
})

export const ManagedDocumentIndexEntrySchema = DocumentIndexCommonSchema.extend({
  origin_kind: z.literal("managed"),
  managed_relative_path: z.string().min(1),
  repository_id: z.null(),
  workspace_id: z.null(),
  repository_relative_path: z.null(),
  branch: z.null(),
}).strict()

export const RepositoryDocumentIndexEntrySchema = DocumentIndexCommonSchema.extend({
  origin_kind: z.literal("repository"),
  managed_relative_path: z.null(),
  repository_id: NonBlankStringSchema,
  workspace_id: NonBlankStringSchema,
  repository_relative_path: NonBlankStringSchema,
  branch: NonBlankStringSchema.nullable(),
}).strict()

export const DocumentIndexEntrySchema = z.discriminatedUnion("origin_kind", [
  ManagedDocumentIndexEntrySchema,
  RepositoryDocumentIndexEntrySchema,
])

export type DocumentIndexEntry = z.infer<typeof DocumentIndexEntrySchema>

export type DocumentIndexScope = Readonly<{
  orgId: string
  projectId: string
}>

export const defaultDocumentStatuses = [
  { id: "draft", name: "Draft", color: "#6b7280", position: 0, transitions: ["in_review", "in_progress"] },
  { id: "in_review", name: "In Review", color: "#f59e0b", position: 1, transitions: ["in_progress", "draft"] },
  { id: "in_progress", name: "In Progress", color: "#3b82f6", position: 2, transitions: ["done", "in_review"] },
  { id: "done", name: "Done", color: "#22c55e", position: 3, transitions: ["archived", "in_progress"] },
  { id: "archived", name: "Archived", color: "#9ca3af", position: 4, transitions: ["draft"] },
] as const
