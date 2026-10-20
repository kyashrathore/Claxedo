import { z } from "zod"
import type { Disposer } from "./contributions"
import { SURFACE_ICON_NAMES } from "./surface/icon-names"

/**
 * A card template is data the host evaluates against `{ args, result }`, the
 * tool call's arguments and its parsed JSON result. Paths are JSON Pointers
 * into that document; inside `rows` they point into the row's own item.
 * Nothing in a template runs code, so the host can draw a plugin's cards in
 * the transcript without the plugin's code in the app's realm.
 */
export const TOOL_CARD_TONES = ["neutral", "info", "success", "warning", "danger"] as const

export type ToolCardTone = (typeof TOOL_CARD_TONES)[number]

export const TOOL_CARD_MAX_TEMPLATES = 64

const TOOL_CARD_TEXT_MAX = 400
const TOOL_CARD_POINTER_PATTERN = /^(?:\/[^/]*)*$/

export type ToolCardText =
  | string
  | { readonly path: string; readonly max?: number }
  | { readonly first: readonly ToolCardText[] }
  | { readonly format: string }
  | { readonly count: { readonly path: string; readonly one: string; readonly other: string } }

export type ToolCardCondition = { readonly path: string; readonly equals?: string | number | boolean }

export type ToolCardStatus = {
  readonly value: ToolCardText
  readonly states: Readonly<Record<string, { readonly label: string; readonly icon?: (typeof SURFACE_ICON_NAMES)[number]; readonly tone?: ToolCardTone }>>
}

export type ToolCardLink =
  | { readonly kind: "page"; readonly pageId: string; readonly params: Readonly<Record<string, ToolCardText>>; readonly label: ToolCardText }
  | { readonly kind: "session"; readonly sessionId: ToolCardText; readonly label?: ToolCardText }

export type ToolCardFact = {
  readonly label: string
  readonly value: ToolCardText | ToolCardLink
  readonly mono?: boolean
  readonly when?: ToolCardCondition
}

export type ToolCardRows = {
  readonly path: string
  readonly link: ToolCardLink
  readonly status?: ToolCardStatus
  readonly max: number
  /** Shown when items were cut at `max`; `{count}` is how many. */
  readonly more?: string
  /** Shown when nothing was cut but the condition holds, as when the result names a next page. */
  readonly continued?: { readonly when: ToolCardCondition; readonly text: string }
}

export type ToolCardTemplate = {
  readonly tool: string
  readonly title: string
  readonly subject?: ToolCardText
  readonly status?: ToolCardStatus
  readonly link?: ToolCardLink
  /** The first note whose condition holds is shown. */
  readonly notes?: readonly { readonly when: ToolCardCondition; readonly text: string }[]
  readonly facts?: readonly ToolCardFact[]
  readonly rows?: ToolCardRows
}

export interface TranscriptApi {
  toolCards(templates: readonly ToolCardTemplate[]): Disposer
}

const pointer = z.string().max(256).regex(TOOL_CARD_POINTER_PATTERN)
const literal = z.string().max(TOOL_CARD_TEXT_MAX)

const toolCardTextSchema: z.ZodType<ToolCardText> = z.lazy(() =>
  z.union([
    literal,
    z.object({ path: pointer, max: z.number().int().min(1).max(TOOL_CARD_TEXT_MAX).optional() }).strict(),
    z.object({ first: z.array(toolCardTextSchema).min(1).max(8) }).strict(),
    z.object({ format: literal }).strict(),
    z.object({ count: z.object({ path: pointer, one: literal, other: literal }).strict() }).strict(),
  ]),
)

const conditionSchema = z.object({ path: pointer, equals: z.union([literal, z.number(), z.boolean()]).optional() }).strict()

const statusSchema = z
  .object({
    value: toolCardTextSchema,
    states: z.record(
      z.string().max(64),
      z.object({ label: literal, icon: z.enum(SURFACE_ICON_NAMES).optional(), tone: z.enum(TOOL_CARD_TONES).optional() }).strict(),
    ),
  })
  .strict()

const linkSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("page"), pageId: z.string().min(1).max(128), params: z.record(z.string().max(64), toolCardTextSchema), label: toolCardTextSchema }).strict(),
  z.object({ kind: z.literal("session"), sessionId: toolCardTextSchema, label: toolCardTextSchema.optional() }).strict(),
])

const factSchema = z
  .object({ label: literal, value: z.union([toolCardTextSchema, linkSchema]), mono: z.boolean().optional(), when: conditionSchema.optional() })
  .strict()

const rowsSchema = z
  .object({
    path: pointer,
    link: linkSchema,
    status: statusSchema.optional(),
    max: z.number().int().min(1).max(50),
    more: literal.optional(),
    continued: z.object({ when: conditionSchema, text: literal }).strict().optional(),
  })
  .strict()

export const toolCardTemplateSchema: z.ZodType<ToolCardTemplate> = z
  .object({
    tool: z.string().regex(/^[a-z][a-z0-9_]*$/).max(64),
    title: literal.min(1),
    subject: toolCardTextSchema.optional(),
    status: statusSchema.optional(),
    link: linkSchema.optional(),
    notes: z.array(z.object({ when: conditionSchema, text: literal }).strict()).max(8).optional(),
    facts: z.array(factSchema).max(16).optional(),
    rows: rowsSchema.optional(),
  })
  .strict()

export const toolCardTemplatesSchema = z.array(toolCardTemplateSchema).max(TOOL_CARD_MAX_TEMPLATES)

export class ToolCardTemplateError extends Error {
  readonly issues: readonly string[]

  constructor(issues: readonly string[]) {
    super(`The tool card templates are invalid: ${issues.join("; ")}`)
    this.name = "ToolCardTemplateError"
    this.issues = issues
  }
}

export function readToolCardTemplates(value: unknown): readonly ToolCardTemplate[] {
  const parsed = toolCardTemplatesSchema.safeParse(value)
  if (parsed.success) return parsed.data
  throw new ToolCardTemplateError(parsed.error.issues.map((issue) => `${issue.path.join(".") || "templates"}: ${issue.message}`))
}
