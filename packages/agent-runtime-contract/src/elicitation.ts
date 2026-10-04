import { isRecord } from "./values"

export type ElicitationChoice = { const: string; title?: string; description?: string }
export type ElicitationContent = Record<string, string | number | boolean | string[]>
export type ElicitationField = {
  type: "string" | "number" | "integer" | "boolean" | "array"
  title?: string
  description?: string
  default?: unknown
  enum?: string[]
  oneOf?: ElicitationChoice[]
  items?: { type?: "string"; enum?: string[]; anyOf?: ElicitationChoice[] }
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  minItems?: number
  maxItems?: number
  format?: string
  /** Native ECMAScript constraint evaluated by the asynchronous response validator. */
  pattern?: string | null
}
export type ElicitationSchema = { type: "object"; properties: Record<string, ElicitationField>; required?: string[]; title?: string; description?: string; _meta?: Record<string, unknown> }
export type AgentElicitation = { agentName: string; message: string } & (
  | { mode: "form"; requestedSchema: ElicitationSchema }
  | { mode: "url"; url: string; elicitationId: string }
)

export function elicitationChoices(field: ElicitationField): ElicitationChoice[] | undefined {
  return field.type === "array"
    ? field.items?.anyOf ?? field.items?.enum?.map((value) => ({ const: value }))
    : field.oneOf ?? field.enum?.map((value) => ({ const: value }))
}

const ELICITATION_FIELD_TYPES = ["string", "number", "integer", "boolean", "array"] as const

export function readElicitationSchema(input: unknown): ElicitationSchema {
  if (!isRecord(input) || input.type !== "object" || !isRecord(input.properties)) throw new Error("Elicitation requires a flat object schema")
  const fields: Record<string, ElicitationField> = Object.create(null)
  for (const [name, value] of Object.entries(input.properties)) {
    const type = isRecord(value) ? ELICITATION_FIELD_TYPES.find((candidate) => candidate === value.type) : undefined
    if (!isRecord(value) || !type) throw new Error(`Unsupported field ${name}`)
    if (value.pattern != null && typeof value.pattern !== "string") throw new Error(`Invalid pattern for ${name}`)
    const choices = value.type === "array" ? isRecord(value.items) ? value.items : undefined : value
    if (value.type === "array" && (!choices || (!Array.isArray(choices.enum) && !Array.isArray(choices.anyOf)))) throw new Error(`Field ${name} must be a string choice array`)
    if (choices?.enum != null && (!Array.isArray(choices.enum) || !choices.enum.every((item) => typeof item === "string"))) throw new Error(`Invalid choices for ${name}`)
    const titled = choices?.oneOf ?? choices?.anyOf
    if (titled != null && (!Array.isArray(titled) || !titled.every((item) => isRecord(item) && typeof item.const === "string"))) throw new Error(`Invalid titled choices for ${name}`)
    // The primitive discriminant and enum payload are checked above. Spreading
    // preserves the rest of the annotations, including unknown string formats,
    // exactly as sent.
    fields[name] = { ...value, type }
  }
  const required = requiredFieldNames(input.required, fields)
  return { ...input, type: "object", properties: fields, required }
}

function requiredFieldNames(value: unknown, fields: Record<string, ElicitationField>): string[] | undefined {
  if (value == null) return undefined
  if (!Array.isArray(value)) throw new Error("Invalid required fields")
  const names: string[] = []
  for (const name of value) {
    if (typeof name !== "string" || !Object.hasOwn(fields, name)) throw new Error("Invalid required fields")
    names.push(name)
  }
  return names
}

function validElicitationDate(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!match) return false
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3])
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!
}

function rfc3339DateTime(text: string): boolean {
  // Require an explicit timezone. Date.parse also accepts year-only input,
  // local times, and normalizes nonexistent dates instead of rejecting them.
  const match = /^(\d{4}-\d{2}-\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.exec(text)
  if (!match || !validElicitationDate(match[1]!)) return false
  const hour = Number(match[2]), minute = Number(match[3]), second = Number(match[4])
  const zone = match[5]!
  const offsetHour = zone.length === 1 ? 0 : Number(zone.slice(1, 3))
  const offsetMinute = zone.length === 1 ? 0 : Number(zone.slice(4, 6))
  if (hour > 23 || minute > 59 || second > 60 || offsetHour > 23 || offsetMinute > 59) return false
  if (second < 60) return true
  // Leap seconds occur at the end of a UTC month, which may be a different
  // local date/hour when an offset is present. Do not hardcode a stale table
  // of historical leap-second announcements.
  const utc = new Date(0)
  const [year, month, day] = match[1]!.split("-").map(Number)
  utc.setUTCFullYear(year!, month! - 1, day)
  utc.setUTCHours(hour, minute, 59, 0)
  const offset = (offsetHour * 60 + offsetMinute) * (zone.startsWith("-") ? -1 : 1)
  utc.setUTCMinutes(utc.getUTCMinutes() - offset)
  if (utc.getUTCHours() !== 23 || utc.getUTCMinutes() !== 59) return false
  utc.setUTCDate(utc.getUTCDate() + 1)
  return utc.getUTCDate() === 1
}

/** Primitive constraints. Use validateElicitationResponse for complete validation including patterns. */
export function validateElicitationContent(schema: ElicitationSchema, value: unknown): asserts value is ElicitationContent {
  if (!isRecord(value)) throw new Error("Enter a form response")
  for (const name of Object.keys(value)) if (!Object.hasOwn(schema.properties, name)) throw new Error(`Unknown field ${name}`)
  for (const [name, field] of Object.entries(schema.properties)) {
    const item = value[name]
    if (item === undefined) {
      if (schema.required?.includes(name)) throw new Error(`${field.title ?? name} is required`)
      continue
    }
    const fail: () => never = () => { throw new Error(`Invalid value for ${field.title ?? name}`) }
    if (field.type === "string") {
      if (typeof item !== "string") fail()
      const text = item
      if (typeof field.minLength === "number" || typeof field.maxLength === "number") {
        let length = 0
        for (const _point of text) length++
        if (typeof field.minLength === "number" && length < field.minLength || typeof field.maxLength === "number" && length > field.maxLength) fail()
      }
      if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) fail()
      if (field.format === "uri") { try { new URL(text) } catch { fail() } }
      if (field.format === "date" && !validElicitationDate(text)) fail()
      if (field.format === "date-time" && !rfc3339DateTime(text)) fail()
    } else if (field.type === "boolean") {
      if (typeof item !== "boolean") fail()
    } else if (field.type === "number" || field.type === "integer") {
      if (typeof item !== "number" || !Number.isFinite(item) || field.type === "integer" && !Number.isInteger(item)) fail()
      if (typeof field.minimum === "number" && item < field.minimum || typeof field.maximum === "number" && item > field.maximum) fail()
    } else if (!Array.isArray(item) || !item.every((entry) => typeof entry === "string") || new Set(item).size !== item.length
      || typeof field.minItems === "number" && item.length < field.minItems || typeof field.maxItems === "number" && item.length > field.maxItems) fail()
    const choices = elicitationChoices(field)
    if (choices && (Array.isArray(item) ? item : [item]).some((entry) => !choices.some((choice) => choice.const === entry))) fail()
  }
}
