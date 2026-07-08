import { Hono } from "hono"
import { getWorkGraph } from "../model/registry"
import type { IntakeActivity, WorkEvent } from "../model/types"

interface ActivityEntry {
  id: string
  kind: string
  actor: string
  at: string
  title: string
  subjectType: string
  subjectId: string
  link?: { type: string; id: string }
  payload: Record<string, unknown>
  order: number
}

export function activityRouter() {
  const router = new Hono()

  router.get("/activity", (c) => {
    const subjectType = c.req.query("subjectType")
    const subjectId = c.req.query("subjectId")
    if (!subjectType || !subjectId) return c.json({ error: "subjectType and subjectId are required" }, 400)
    const before = c.req.query("before")
    const limit = Number(c.req.query("limit") ?? "50") || 50
    const entries = activityFor(subjectType, subjectId)
      .filter((entry) => !before || entry.at < before)
      .sort((a, b) => a.at.localeCompare(b.at) || a.order - b.order)
      .slice(0, limit)
    return c.json({ entries })
  })

  return router
}

function activityFor(subjectType: string, subjectId: string): ActivityEntry[] {
  const graph = getWorkGraph()
  return [
    ...(subjectType === "intake_item"
      ? graph.getState().intakeActivities
        .filter((activity) => activity.intakeItemId === subjectId)
        .map((activity) => fromIntakeActivity(activity, subjectType, subjectId))
      : []),
    ...graph.getEvents()
      .map((event) => fromEvent(event, subjectType, subjectId))
      .filter((entry): entry is ActivityEntry => !!entry),
  ]
}

function fromIntakeActivity(activity: IntakeActivity, subjectType: string, subjectId: string): ActivityEntry {
  return {
    id: activity.id,
    kind: activity.kind,
    actor: activity.actor,
    at: activity.createdAt,
    title: activity.kind === "capture"
      ? "Captured intake"
      : activity.kind === "triage_failed"
        ? "Triage failed"
        : titleize(activity.kind),
    subjectType,
    subjectId,
    payload: activity.payload,
    order: 0,
  }
}

function fromEvent(event: WorkEvent, subjectType: string, subjectId: string): ActivityEntry | null {
  const payload = JSON.parse(event.payload) as Record<string, unknown>
  if (subjectType === "intake_item") return intakeEvent(event, payload, subjectType, subjectId)
  if (subjectType === "work_item" || subjectType === "mission") return workEvent(event, payload, subjectType, subjectId)
  return null
}

function intakeEvent(event: WorkEvent, payload: Record<string, unknown>, subjectType: string, subjectId: string): ActivityEntry | null {
  if (event.type === "intake_item_updated" && payload.id === subjectId) {
    const changes = record(payload.changes)
    if (changes?.status === "triaging") return entry(event, "triage_started", "Triage started", subjectType, subjectId, payload)
    if (changes?.status === "triaged") return entry(event, "triage_completed", "Triage completed", subjectType, subjectId, payload)
  }
  if (event.type === "scratchpad_written" && (payload.subjectType === subjectType && payload.subjectId === subjectId || payload.workItemId === subjectId)) {
    return entry(event, "scratchpad_written", "Scratchpad written", subjectType, subjectId, payload, { type: "scratchpad", id: text(payload.id) ?? event.id })
  }
  if (event.type === "captain_proposed") {
    const intent = record(payload.intent)
    if (intent?.subjectType === subjectType && intent.subjectId === subjectId) {
      return entry(event, "captain_proposed", `Captain proposed: ${proposalTitle(intent)}`, subjectType, subjectId, payload)
    }
  }
  if ((event.type === "decision_created" || event.type === "decision_resolved") && payload.subjectType === subjectType && payload.subjectId === subjectId) {
    return entry(event, event.type, decisionTitle(event.type, payload), subjectType, subjectId, payload, { type: "decision", id: text(payload.id) ?? event.id })
  }
  return null
}

function workEvent(event: WorkEvent, payload: Record<string, unknown>, subjectType: string, subjectId: string): ActivityEntry | null {
  if (event.type === "scratchpad_written" && (payload.subjectType === "run_node" && payload.subjectId === subjectId || payload.workItemId === subjectId)) {
    return entry(event, "scratchpad_written", "Scratchpad written", subjectType, subjectId, payload, { type: "scratchpad", id: text(payload.id) ?? event.id })
  }
  if ((event.type === "item_created" || event.type === "item_updated") && touchesWorkItem(payload, subjectId)) {
    return entry(event, event.type, event.type === "item_created" ? "Created work item" : "Updated work item", subjectType, subjectId, payload)
  }
  if (event.type === "captain_proposed") {
    const intent = record(payload.intent)
    if (intent?.subjectType === "work_item" && intent.subjectId === subjectId) {
      return entry(event, "captain_proposed", `Captain proposed: ${proposalTitle(intent)}`, subjectType, subjectId, payload)
    }
  }
  if ((event.type === "decision_created" || event.type === "decision_resolved") && payload.subjectType === "work_item" && payload.subjectId === subjectId) {
    return entry(event, event.type, decisionTitle(event.type, payload), subjectType, subjectId, payload, { type: "decision", id: text(payload.id) ?? event.id })
  }
  return null
}

function entry(
  event: WorkEvent,
  kind: string,
  title: string,
  subjectType: string,
  subjectId: string,
  payload: Record<string, unknown>,
  link?: ActivityEntry["link"],
): ActivityEntry {
  return {
    id: event.id,
    kind,
    actor: event.actor,
    at: event.createdAt,
    title,
    subjectType,
    subjectId,
    link,
    payload,
    order: event.seq,
  }
}

function proposalTitle(intent: Record<string, unknown>) {
  return text(intent.title) ?? text(intent.intentKind) ?? "graph change"
}

function decisionTitle(kind: string, payload: Record<string, unknown>) {
  const recommended = record(payload.recommendedIntentPayload)
  const title = text(recommended?.title) ?? text(payload.intentKind) ?? "decision"
  return kind === "decision_created" ? `Decision needed: ${title}` : `Decision resolved: ${title}`
}

function touchesWorkItem(payload: Record<string, unknown>, subjectId: string) {
  const item = record(payload.item)
  return payload.id === subjectId || item?.id === subjectId
}

function record(value: unknown): Record<string, unknown> | null {
  return !!value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function titleize(value: string) {
  return value.split("_").map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(" ")
}
