import type { ToolCardCondition, ToolCardLink, ToolCardRows, ToolCardStatus, ToolCardTemplate, ToolCardText, ToolCardTone } from "@claxedo/plugin-api"
import { isRecord } from "@claxedo/helpers/guards"
import { parsePointer } from "@/lib/json-pointer"
import { clampLabel } from "./message-part-text"

export type TranscriptToolCard = {
  readonly template: ToolCardTemplate
  readonly pageHref: (pageId: string, params: Readonly<Record<string, string>>) => string | undefined
}

export type ClaxedoLink =
  | { readonly kind: "session"; readonly id: string; readonly label: string }
  | { readonly kind: "page"; readonly href: string | undefined; readonly label: string }

export function claxedoLinkHref(link: ClaxedoLink, sessionHref: ((sessionId: string) => string) | undefined): string | undefined {
  return link.kind === "page" ? link.href : sessionHref?.(link.id)
}

export type ClaxedoStatusIcon = NonNullable<ToolCardStatus["states"][string]["icon"]>

export type ClaxedoStatus = { readonly label: string; readonly icon?: ClaxedoStatusIcon; readonly tone: ToolCardTone }

export type ClaxedoFact = { label: string; value: string; link?: ClaxedoLink; mono?: boolean }

export type ClaxedoRow = { link: ClaxedoLink; status?: ClaxedoStatus }

export type ToolCardFields = {
  subject?: string
  link?: ClaxedoLink
  status?: ClaxedoStatus
  note?: string
  facts: ClaxedoFact[]
  rows: ClaxedoRow[]
  more?: string
}

const SESSION_LABEL_MAX = 28

function child(value: unknown, segment: string): unknown {
  if (Array.isArray(value)) return /^(?:0|[1-9]\d*)$/.test(segment) ? value[Number(segment)] : undefined
  return isRecord(value) && Object.hasOwn(value, segment) ? value[segment] : undefined
}

export function pointerValue(document: unknown, pointer: string): unknown {
  return parsePointer(pointer).reduce(child, document)
}

function scalarText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() ? value : undefined
  return typeof value === "number" && Number.isFinite(value) ? String(value) : undefined
}

function countOf(value: unknown): number | undefined {
  if (Array.isArray(value)) return value.length
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function cardText(text: ToolCardText, document: unknown): string | undefined {
  if (typeof text === "string") return text || undefined
  if ("path" in text) {
    const value = scalarText(pointerValue(document, text.path))
    return value === undefined || text.max === undefined ? value : clampLabel(value, text.max)
  }
  if ("first" in text) {
    for (const option of text.first) {
      const value = cardText(option, document)
      if (value !== undefined) return value
    }
    return undefined
  }
  if ("format" in text) return formattedText(text.format, document)
  const count = countOf(pointerValue(document, text.count.path))
  return count === undefined ? undefined : `${count} ${count === 1 ? text.count.one : text.count.other}`
}

function formattedText(format: string, document: unknown): string | undefined {
  let missing = false
  const text = format.replace(/\{(\/[^}]*)\}/g, (_, pointer: string) => {
    const value = scalarText(pointerValue(document, pointer))
    if (value === undefined) missing = true
    return value ?? ""
  })
  return missing ? undefined : text
}

export function conditionHolds(condition: ToolCardCondition, document: unknown): boolean {
  const value = pointerValue(document, condition.path)
  if (condition.equals === undefined) return value !== undefined && value !== null
  return value === condition.equals
}

function pageHref(link: Extract<ToolCardLink, { kind: "page" }>, document: unknown, card: TranscriptToolCard): string | undefined {
  const params: Record<string, string> = {}
  for (const [name, text] of Object.entries(link.params)) {
    const value = cardText(text, document)
    if (value === undefined) return undefined
    params[name] = value
  }
  return card.pageHref(link.pageId, params)
}

export function cardLink(link: ToolCardLink, document: unknown, card: TranscriptToolCard): ClaxedoLink | undefined {
  if (link.kind === "session") {
    const id = cardText(link.sessionId, document)
    if (id === undefined) return undefined
    return { kind: "session", id, label: (link.label ? cardText(link.label, document) : undefined) ?? clampLabel(id, SESSION_LABEL_MAX) }
  }
  const label = cardText(link.label, document)
  return label === undefined ? undefined : { kind: "page", href: pageHref(link, document, card), label }
}

export function cardStatus(status: ToolCardStatus, document: unknown): ClaxedoStatus | undefined {
  const value = cardText(status.value, document)
  if (value === undefined) return undefined
  const state = Object.hasOwn(status.states, value) ? status.states[value] : undefined
  if (!state) return { label: value.replaceAll("_", " "), tone: "neutral" }
  return { label: state.label, tone: state.tone ?? "neutral", ...(state.icon ? { icon: state.icon } : {}) }
}

function cardFacts(template: ToolCardTemplate, document: unknown, card: TranscriptToolCard): ClaxedoFact[] {
  return (template.facts ?? []).flatMap((fact): ClaxedoFact[] => {
    if (fact.when && !conditionHolds(fact.when, document)) return []
    if (typeof fact.value === "object" && "kind" in fact.value) {
      const link = cardLink(fact.value, document, card)
      return link ? [{ label: fact.label, value: link.label, link }] : []
    }
    const value = cardText(fact.value, document)
    return value === undefined ? [] : [{ label: fact.label, value, ...(fact.mono ? { mono: true } : {}) }]
  })
}

function cardRows(rows: ToolCardRows, document: unknown, card: TranscriptToolCard): Pick<ToolCardFields, "rows" | "more"> {
  const items = pointerValue(document, rows.path)
  const drawn = (Array.isArray(items) ? items : []).flatMap((item: unknown) => {
    const link = cardLink(rows.link, item, card)
    if (!link) return []
    const status = rows.status ? cardStatus(rows.status, item) : undefined
    return [{ link, ...(status ? { status } : {}) }]
  })
  const hidden = Math.max(0, drawn.length - rows.max)
  const more = hidden > 0 ? rows.more?.replaceAll("{count}", String(hidden)) : rows.continued && conditionHolds(rows.continued.when, document) ? rows.continued.text : undefined
  return { rows: drawn.slice(0, rows.max), ...(more ? { more } : {}) }
}

export function toolCardFields(card: TranscriptToolCard, document: { readonly args: unknown; readonly result: unknown }): ToolCardFields {
  const { template } = card
  const link = template.link ? cardLink(template.link, document, card) : undefined
  const subject = template.subject ? cardText(template.subject, document) : undefined
  const status = template.status ? cardStatus(template.status, document) : undefined
  const note = template.notes?.find((candidate) => conditionHolds(candidate.when, document))?.text
  return {
    ...(link ? { link } : {}),
    ...(subject ? { subject } : {}),
    ...(status ? { status } : {}),
    ...(note ? { note } : {}),
    facts: cardFacts(template, document, card),
    ...(template.rows ? cardRows(template.rows, document, card) : { rows: [] }),
  }
}
