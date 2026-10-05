import { isRecord } from "@claxedo/helpers/guards"
import type { DecodeResult } from "./operation-definition"

const ONBOARDING_STEPS = ["project", "ai", "execution"] as const
const HARNESSES = ["claude", "codex", "cursor", "pi", "opencode", "connection"] as const
const ERROR_CLASSES = ["auth", "rate_limit", "network", "not_found", "conflict", "invalid", "internal"] as const
const ERROR_SURFACES = ["startup", "connections", "organization", "terminal", "usage", "review"] as const
const TOOL_KINDS = ["bash", "edit", "write", "read", "list", "grep", "glob", "websearch", "webfetch", "task", "mcp", "other"] as const
const FEATURES = ["terminal", "marketplace_install", "file_open", "review"] as const

/**
 * Every event the app may send to `POST /api/claxedo/track`, with the closed set
 * of values each property may take. The route refuses any other event, drops any
 * other property, and refuses a value outside its set, so nothing free-form
 * (prompt text, paths, names, emails) can ride along.
 */
export const PRODUCT_EVENTS = {
  onboarding_step_viewed: { step: ONBOARDING_STEPS },
  onboarding_step_completed: { step: ONBOARDING_STEPS },
  onboarding_abandoned: { step: ONBOARDING_STEPS },
  session_started: { harness: HARNESSES, where: ["machine", "cloud"] },
  permission_decided: { decision: ["allow", "deny"], tool_kind: TOOL_KINDS },
  ui_error_shown: { error_class: ERROR_CLASSES, surface: ERROR_SURFACES },
  feature_used: { feature: FEATURES },
} as const satisfies Record<string, Record<string, readonly string[]>>

type Events = typeof PRODUCT_EVENTS
export type ProductEventName = keyof Events
export type ProductEventProperties<N extends ProductEventName> = { readonly [K in keyof Events[N]]: Events[N][K] extends readonly (infer V)[] ? V : never }
export type ProductEvent = { [N in ProductEventName]: { readonly event: N; readonly properties: ProductEventProperties<N> } }[ProductEventName]
export type ProductToolKind = (typeof TOOL_KINDS)[number]

export function isProductToolKind(value: string): value is ProductToolKind {
  return (TOOL_KINDS as readonly string[]).includes(value)
}

function isProductEventName(value: unknown): value is ProductEventName {
  return typeof value === "string" && Object.hasOwn(PRODUCT_EVENTS, value)
}

export function decodeProductEvent(raw: unknown): DecodeResult<ProductEvent> {
  if (!isRecord(raw) || !isProductEventName(raw.event)) return { ok: false, reason: "unknown_event" }
  const sent = isRecord(raw.properties) ? raw.properties : {}
  const allowed: Readonly<Record<string, readonly string[]>> = PRODUCT_EVENTS[raw.event]
  const properties: Record<string, string> = {}
  for (const [key, values] of Object.entries(allowed)) {
    const value = sent[key]
    if (typeof value !== "string" || !values.includes(value)) return { ok: false, reason: `invalid_property:${key}` }
    properties[key] = value
  }
  return { ok: true, value: { event: raw.event, properties } as ProductEvent }
}
