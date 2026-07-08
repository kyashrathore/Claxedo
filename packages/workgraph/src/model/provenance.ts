import type { Provenance, WorkEdge, WorkEvent, WorkItem } from "./types"

export type { Provenance }

export type ProvenanceInput = Partial<Provenance>

export interface FreshnessSignal {
  lastTouchedBy: Provenance["actor"]
  lastTouchedAt: string
  lastTouchedConfidence: number | null
}

export function buildProvenance(input: ProvenanceInput = {}, defaults: ProvenanceInput = {}): Provenance {
  return {
    actor: input.actor ?? defaults.actor ?? "system",
    at: input.at ?? defaults.at ?? new Date().toISOString(),
    confidence: input.confidence ?? defaults.confidence ?? null,
    evidence: input.evidence ?? defaults.evidence ?? null,
    sourceIntakeItemId: input.sourceIntakeItemId ?? defaults.sourceIntakeItemId ?? null,
    firedRuleId: input.firedRuleId ?? defaults.firedRuleId ?? null,
  }
}

export function mostRecentProvenance(itemId: string, events: WorkEvent[]): Provenance | null {
  return events
    .slice()
    .reverse()
    .map((event) => ({ event, payload: JSON.parse(event.payload) }))
    .find((entry) => touchesItem(itemId, entry.event, entry.payload) && provenanceOf(entry.payload))?.payload.provenance ?? null
}

export function freshnessOf(itemId: string, events: WorkEvent[]): FreshnessSignal | null {
  const provenance = mostRecentProvenance(itemId, events)
  if (!provenance) return null
  return {
    lastTouchedBy: provenance.actor,
    lastTouchedAt: provenance.at,
    lastTouchedConfidence: provenance.confidence,
  }
}

function provenanceOf(payload: unknown): Provenance | null {
  if (!isRecord(payload) || !isRecord(payload.provenance)) return null
  return payload.provenance as unknown as Provenance
}

function touchesItem(itemId: string, event: WorkEvent, payload: unknown) {
  if (event.type === "item_created" || event.type === "item_hydrated") return itemOf(payload)?.id === itemId
  if (event.type === "item_updated" || event.type === "item_synced" || event.type === "item_removed") return idOf(payload) === itemId
  if (event.type === "edge_added" || event.type === "edge_removed") {
    const edge = edgeOf(payload)
    return edge?.source === itemId || edge?.target === itemId
  }
  return false
}

function itemOf(payload: unknown): WorkItem | null {
  if (!isRecord(payload)) return null
  if (isRecord(payload.item)) return payload.item as unknown as WorkItem
  return typeof payload.id === "string" ? payload as unknown as WorkItem : null
}

function edgeOf(payload: unknown): WorkEdge | null {
  if (!isRecord(payload)) return null
  if (isRecord(payload.edge)) return payload.edge as unknown as WorkEdge
  return typeof payload.source === "string" && typeof payload.target === "string" ? payload as unknown as WorkEdge : null
}

function idOf(payload: unknown) {
  return isRecord(payload) && typeof payload.id === "string" ? payload.id : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
