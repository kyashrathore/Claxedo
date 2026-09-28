import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { frameSessionId, frameType, type EventStream, type StreamFrame } from "../harness/stream"

export const WATCHED_EVENTS = ["session.status", "session.idle", "session.error", "permission.asked", "question.asked"] as const
export type WatchedEvent = (typeof WATCHED_EVENTS)[number]

export type TurnRecord = {
  harness: string
  turn: string
  outcome: string
  counts: Record<WatchedEvent, number>
  lifecycle: string[]
  statuses: string[]
  types: string[]
}

export type TurnObservation = { start: number; sessionId: string }

export function beginObservation(stream: EventStream, sessionId: string): TurnObservation {
  return { start: stream.frames.length, sessionId }
}

function belongsTo(frame: StreamFrame, sessionId: string) {
  return frameSessionId(frame) === sessionId
}

function statusOf(frame: StreamFrame): string | undefined {
  const payload = frame.data.payload as { properties?: { status?: { type?: unknown } } } | undefined
  const type = payload?.properties?.status?.type
  return typeof type === "string" ? type : undefined
}

function lifecycleOf(frame: StreamFrame): string | undefined {
  const payload = frame.data.payload as { type?: unknown; eventType?: unknown; sessionId?: unknown } | undefined
  if (payload?.type !== "agent.lifecycle" || typeof payload.eventType !== "string") return undefined
  return payload.eventType
}

export function recordTurn(
  stream: EventStream,
  observation: TurnObservation,
  input: { harness: string; turn: string; outcome: string },
): TurnRecord {
  const frames = stream.frames.slice(observation.start)
  const own = frames.filter((frame) => belongsTo(frame, observation.sessionId) || lifecycleTargets(frame, observation.sessionId))
  const counts = Object.fromEntries(WATCHED_EVENTS.map((name) => [name, 0])) as Record<WatchedEvent, number>
  const types: string[] = []
  const statuses: string[] = []
  const lifecycle: string[] = []
  for (const frame of own) {
    const type = frameType(frame)
    if (type) types.push(type)
    if (type && (WATCHED_EVENTS as readonly string[]).includes(type)) counts[type as WatchedEvent] += 1
    const status = statusOf(frame)
    if (type === "session.status" && status) statuses.push(status)
    const event = lifecycleOf(frame)
    if (event) lifecycle.push(event)
  }
  return { harness: input.harness, turn: input.turn, outcome: input.outcome, counts, lifecycle, statuses, types }
}

function lifecycleTargets(frame: StreamFrame, sessionId: string) {
  const payload = frame.data.payload as { type?: unknown; sessionId?: unknown } | undefined
  return payload?.type === "agent.lifecycle" && payload.sessionId === sessionId
}

function findings(records: TurnRecord[]) {
  const ended = records.filter((record) => record.counts["session.idle"] > 0 || record.counts["session.error"] > 0)
  const withoutIdleStatus = records.filter((record) => record.statuses.at(-1) !== "idle")
  const lines = [`- ${ended.length} of ${records.length} turns ended with \`session.idle\` or \`session.error\` on the stream.`]
  if (withoutIdleStatus.length === 0) return [...lines, "- Every turn's last `session.status` was `idle`."]
  const turns = withoutIdleStatus.map((record) => `${record.harness} ${record.turn}`).join("; ")
  return [...lines, `- ${withoutIdleStatus.length} turns never sent \`session.status: idle\`; their last status stayed \`busy\` or absent: ${turns}. Only \`session.idle\` or \`session.error\` ends those turns.`]
}

function cell(count: number) {
  return count > 0 ? `yes (${count})` : "no"
}

export function renderReport(input: { records: TurnRecord[]; skipped: string[]; startedAt: Date }) {
  const header = ["Harness", "Turn", "Outcome", ...WATCHED_EVENTS, "agent.lifecycle", "session.status types"]
  const rows = input.records.map((record) => [
    record.harness,
    record.turn,
    record.outcome,
    ...WATCHED_EVENTS.map((name) => cell(record.counts[name])),
    record.lifecycle.length ? record.lifecycle.join(", ") : "none",
    record.statuses.length ? record.statuses.join(", ") : "none",
  ])
  const table = [header, header.map(() => "---"), ...rows].map((row) => `| ${row.join(" | ")} |`).join("\n")
  const raw = input.records.map((record) => `- ${record.harness} / ${record.turn}: ${record.types.join(", ") || "(no frames)"}`).join("\n")
  const skipped = input.skipped.length ? input.skipped.map((line) => `- ${line}`).join("\n") : "- none"
  return [
    "# P0.7 probe: harness status on the stream the app reads",
    "",
    `Recorded ${input.startedAt.toISOString()} against the real self-hosted daemon, reading \`/api/wr/events?directory=…\`, the stream the app subscribes to. Each row is one turn; a cell says whether that event type arrived on the stream for that session during the turn, and how many times.`,
    "",
    table,
    "",
    "## Findings",
    "",
    ...findings(input.records),
    "",
    "## Every frame type seen per turn",
    "",
    raw,
    "",
    "## Skipped",
    "",
    skipped,
    "",
  ].join("\n")
}

export async function writeReport(text: string) {
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-probe-harness-status-")), "report.md")
  await fs.writeFile(file, text)
  return file
}
