import { z } from "zod"
import { MAX_HOST_SESSION_ROWS } from "../platform/auth/host-session-rows"
import { sessionAttentionSchema } from "./reader-contract"
import { sessionTurnOutcomeSchema } from "./turn-outcome-contract"

const id = z.string().trim().min(1).max(512)
const position = z.number().int().nonnegative().safe()
export const sessionPublicationRefSchema = z.object({ workspaceId: id, sessionId: id }).strict()
export const sessionAttentionEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("outcome"), sequence: position, openedAt: position, outcome: z.enum(["completed", "failed", "cancelled"]) }).strict(),
  z.object({ kind: z.literal("question"), sequence: position, openedAt: position, requestId: id }).strict(),
  z.object({ kind: z.literal("permission"), sequence: position, openedAt: position, requestId: id }).strict(),
])
export const sessionAttentionPublicationSchema = sessionPublicationRefSchema.extend({
  generation: position,
  through: position,
  events: z.array(sessionAttentionEventSchema).max(256),
}).strict().refine((batch) => batch.events.every((event, index) => event.sequence > batch.generation
  && event.sequence <= batch.through && (index === 0 || event.sequence > batch.events[index - 1].sequence)), "Attention events must be ordered within their generation and through position")
export const sessionAttentionPageSchema = z.object({
  generation: position,
  through: position,
  events: z.array(sessionAttentionEventSchema).max(256),
  next: position.optional(),
}).strict().refine((page) => page.through >= page.generation
  && page.events.every((event, index) => event.sequence > page.generation && event.sequence <= page.through
    && (index === 0 || event.sequence > page.events[index - 1].sequence))
  && (page.next === undefined || page.events.length > 0 && page.next === page.events.at(-1)!.sequence
    && page.next < page.through), "Invalid attention page positions")
export const sessionPublicationRowSchema = sessionPublicationRefSchema.extend({
  replayed: z.boolean().optional(),
  title: z.string().max(2_000).optional(),
  parentSessionId: id.optional(),
  createdAt: position,
  updatedAt: position,
  lastHumanTurnAt: position.optional(),
  archivedAt: position.optional(),
  attention: sessionAttentionSchema.optional(),
  lastTurn: sessionTurnOutcomeSchema.optional(),
  status: z.object({
    kind: z.enum(["idle", "busy", "retry", "interrupted"]),
    awaitingInput: z.boolean(),
    backgroundWork: z.object({ agents: position, shells: position, other: position }).strict().optional(),
    at: position,
  }).strict(),
}).strict()
export const sessionPublicationSchema = z.object({
  rows: z.array(sessionPublicationRowSchema).max(MAX_HOST_SESSION_ROWS),
  removed: z.array(sessionPublicationRefSchema).max(MAX_HOST_SESSION_ROWS),
  attention: z.array(sessionAttentionPublicationSchema).max(MAX_HOST_SESSION_ROWS).optional(),
}).strict()
