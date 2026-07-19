import { z } from "zod"
import { ContentHashSchema } from "./work-source"

/** Versioned standing instructions for every agent acting on a Stream. The
 *  hash is normalized to lowercase at the contract boundary so acceptance,
 *  storage, and the master's audit echo all agree on one canonical form. */
export const StreamCharterSchema = z.strictObject({
  text: z.string(),
  hash: ContentHashSchema.transform((hash) => hash.toLowerCase() as typeof hash),
})
export type StreamCharter = z.infer<typeof StreamCharterSchema>

export const DEFAULT_STREAM_CHARTER_HINTS = [
  "Open draft pull requests by default.",
  "Keep notifications within the configured sender rate limits.",
  "Ask before the first externally visible action.",
] as const
