import { z } from "zod"

const targetContext = {
  targetStreamId: z.string().trim().min(1).optional(),
  directory: z.string().trim().min(1).optional(),
  repositoryUrl: z.string().url().optional(),
}

export const DocumentWorkSourceRequestSchema = z.strictObject({
  projectId: z.string().trim().min(1),
  documentId: z.string().trim().min(1),
  placement: z.enum(["local", "hosted"]),
  ...targetContext,
})
export type DocumentWorkSourceRequest = z.infer<typeof DocumentWorkSourceRequestSchema>

export const DocumentSnapshotLocatorSchema = z.strictObject({
  projectId: z.string().trim().min(1),
  documentId: z.string().trim().min(1),
  snapshotId: z.string().trim().min(1),
  placement: z.enum(["local", "hosted"]),
  ...targetContext,
})
export type DocumentSnapshotLocator = z.infer<typeof DocumentSnapshotLocatorSchema>

export const DocumentSnapshotForWorkSchema = z.strictObject({
  locator: DocumentSnapshotLocatorSchema,
  documentTitle: z.string().trim().min(1),
  markdown: z.string().refine((value) => value.trim().length > 0, "Document must contain non-whitespace markdown"),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/i),
  authoredAt: z.number().int().nonnegative(),
  authoredBy: z.strictObject({
    type: z.enum(["user", "agent", "system"]),
    id: z.string().trim().min(1),
  }),
})
export type DocumentSnapshotForWork = z.infer<typeof DocumentSnapshotForWorkSchema>
