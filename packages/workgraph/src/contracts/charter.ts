import { z } from "zod"
import { ContentHashSchema } from "./work-source"

/** Versioned standing instructions for every agent acting on a Stream. */
export const StreamCharterSchema = z.strictObject({
  text: z.string(),
  hash: ContentHashSchema,
})
export type StreamCharter = z.infer<typeof StreamCharterSchema>

export const DEFAULT_STREAM_CHARTER_HINTS = [
  "Open draft pull requests by default.",
  "Keep notifications within the configured sender rate limits.",
  "Ask before the first externally visible action.",
] as const
