import { z } from "zod"
import { parseSessionAttention, parseSessionReader, type SessionAttentionFacts, type SessionReaderCommand, type SessionReaderState } from "@claxedo/agent-runtime-contract"

const position = z.number().int().nonnegative().safe()
export const sessionAttentionSchema = z.custom<SessionAttentionFacts>((value) => valid(value, parseSessionAttention))
export const sessionReaderSchema = z.custom<SessionReaderState>((value) => valid(value, parseSessionReader))

function valid(value: unknown, parse: (value: unknown) => unknown) {
  try { return parse(value) !== undefined } catch { return false }
}

export const sessionReaderCommandSchema: z.ZodType<SessionReaderCommand> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("seen"), generation: position, outcomeSequence: position }).strict(),
  z.object({ kind: z.literal("settle"), generation: position, activitySequence: position, outcomeSequence: position.optional(), revision: position }).strict(),
  z.object({ kind: z.literal("return"), generation: position, revision: position }).strict(),
])

export function storedSessionAttention(json: string | null | undefined) {
  return json == null ? undefined : sessionAttentionSchema.parse(JSON.parse(json))
}

export function storedSessionReader(json: string | null | undefined) {
  return json == null ? undefined : sessionReaderSchema.parse(JSON.parse(json))
}
