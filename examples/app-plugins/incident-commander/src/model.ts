export type Severity = "SEV1" | "SEV2" | "SEV3" | "SEV4"
export type IncidentStatus = "investigating" | "identified" | "monitoring" | "resolved"

export const SEVERITIES: readonly Severity[] = ["SEV1", "SEV2", "SEV3", "SEV4"]
export const STATUSES: readonly IncidentStatus[] = ["investigating", "identified", "monitoring", "resolved"]
export const STATUS_LABEL: Record<IncidentStatus, string> = {
  investigating: "Investigating",
  identified: "Identified",
  monitoring: "Monitoring",
  resolved: "Resolved",
}
export const SEVERITY_MEANING: Record<Severity, string> = {
  SEV1: "critical, customer-facing outage",
  SEV2: "major degradation for many customers",
  SEV3: "partial degradation with a workaround",
  SEV4: "minor issue, no customer impact",
}

export const SERVICES = ["api-gateway", "auth", "checkout", "payments", "search", "notifications"] as const
export type Service = (typeof SERVICES)[number]
export const RESPONDERS = ["Priya", "Marco", "Ana", "Lee", "Sam", "Jordan"] as const

const RUNBOOKS: Record<Service, readonly string[]> = {
  "api-gateway": ["Check 5xx rate per upstream on the gateway dashboard", "Look for a config push in the last hour", "Shift traffic away from the unhealthy region", "Raise rate limits only if saturation is confirmed"],
  auth: ["Verify the identity provider status page", "Check token signing key rotation", "Confirm session store latency and evictions"],
  checkout: ["Compare cart-to-order conversion with last week", "Check the payment and inventory dependency health", "Disable the newest checkout feature flag", "Place a test order in production"],
  payments: ["Check the processor's status and our webhook backlog", "Look for spikes in declined or timed-out charges", "Pause retries if the processor is degraded"],
  search: ["Check index freshness and indexing lag", "Look at query latency by cluster node", "Fail over to the replica cluster"],
  notifications: ["Check queue depth and consumer lag", "Verify the email and push provider status", "Throttle non-critical campaigns"],
}

export type RunbookStep = { id: string; label: string; done: boolean }
export type Runbook = { service: Service; steps: RunbookStep[] }
export type TimelineEntry = { at: number; from: IncidentStatus | null; to: IncidentStatus; note: string }
export type StatusUpdate = { id: string; at: number; status: IncidentStatus; text: string }
export type Impact = { usersPercent: number; errorRate: number }

export type Incident = {
  title: string
  severity: Severity
  services: Service[]
  commander: string
  comms: string
  scribe: string
  declaredAt: number
  status: IncidentStatus
  resolvedAt: number | null
  timeline: TimelineEntry[]
  updates: StatusUpdate[]
  runbooks: Runbook[]
  impact: Impact
  nextId: number
}

export type DeclareInput = { title: unknown; severity: unknown; services: unknown; commander: unknown; comms: unknown; scribe: unknown }
export type Declared = { incident: Incident; errors: [] } | { incident: null; errors: string[] }
export type Change = { incident: Incident; error?: string }

function first(value: unknown): string | undefined {
  if (typeof value === "string") return value
  return Array.isArray(value) && typeof value[0] === "string" ? value[0] : undefined
}

function isOneOf<T extends string>(options: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (options as readonly string[]).includes(value)
}

export function isStatus(value: unknown): value is IncidentStatus {
  return isOneOf(STATUSES, value)
}

export function runbookFor(service: Service): Runbook {
  return { service, steps: RUNBOOKS[service].map((label, index) => ({ id: `${service}-${index}`, label, done: false })) }
}

export function declareIncident(input: DeclareInput, now: number): Declared {
  const errors: string[] = []
  const title = typeof input.title === "string" ? input.title.trim() : ""
  if (title.length < 4) errors.push("Give the incident a title of at least 4 characters.")
  const severity = first(input.severity)
  if (!isOneOf(SEVERITIES, severity)) errors.push("Pick a severity.")
  const picked: unknown[] = Array.isArray(input.services) ? input.services : []
  const services = SERVICES.filter((service) => picked.includes(service))
  if (services.length === 0) errors.push("Pick at least one affected service.")
  const [commander, comms, scribe] = [first(input.commander), first(input.comms), first(input.scribe)]
  if (!isOneOf(RESPONDERS, commander)) errors.push("Assign an incident commander.")
  if (!isOneOf(RESPONDERS, comms)) errors.push("Assign a comms lead.")
  if (!isOneOf(RESPONDERS, scribe)) errors.push("Assign a scribe.")
  if (commander && commander === comms) errors.push("The commander and the comms lead should be different people.")
  if (errors.length > 0 || !isOneOf(SEVERITIES, severity) || !commander || !comms || !scribe) return { incident: null, errors }
  return {
    incident: {
      title,
      severity,
      services,
      commander,
      comms,
      scribe,
      declaredAt: now,
      status: "investigating",
      resolvedAt: null,
      timeline: [{ at: now, from: null, to: "investigating", note: `Declared ${severity}` }],
      updates: [],
      runbooks: services.map(runbookFor),
      impact: { usersPercent: 0, errorRate: 0 },
      nextId: 1,
    },
    errors: [],
  }
}

export function elapsedSeconds(incident: Incident, now: number): number {
  return Math.max(0, Math.floor(((incident.resolvedAt ?? now) - incident.declaredAt) / 1000))
}

export function formatDuration(seconds: number): string {
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`
}

export function transition(incident: Incident, to: unknown, now: number, note: string): Change {
  if (!isStatus(to)) return { incident, error: "Pick a status." }
  if (incident.status === "resolved") return { incident, error: "The incident is resolved." }
  if (to === incident.status) return { incident, error: `Already ${STATUS_LABEL[to].toLowerCase()}.` }
  const entry: TimelineEntry = { at: now, from: incident.status, to, note: note.trim() }
  return {
    incident: { ...incident, status: to, resolvedAt: to === "resolved" ? now : null, timeline: [...incident.timeline, entry] },
  }
}

export function resolve(incident: Incident, now: number, note: string): Change {
  return transition(incident, "resolved", now, note || "Resolved")
}

export function addUpdate(incident: Incident, text: string, now: number): Change {
  const body = text.trim()
  if (body.length < 10) return { incident, error: "Write at least a sentence for stakeholders." }
  const update: StatusUpdate = { id: `update-${incident.nextId}`, at: now, status: incident.status, text: body }
  return { incident: { ...incident, updates: [...incident.updates, update], nextId: incident.nextId + 1 } }
}

function numberFrom(value: unknown): number {
  if (typeof value === "number") return value
  return typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN
}

export function recordImpact(incident: Incident, usersPercent: unknown, errorRate: unknown): Change {
  const users = numberFrom(usersPercent)
  const rate = numberFrom(errorRate)
  if (!Number.isFinite(users) || users < 0 || users > 100) return { incident, error: "Users affected is a percentage from 0 to 100." }
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) return { incident, error: "Error rate is a percentage from 0 to 100." }
  return { incident: { ...incident, impact: { usersPercent: Math.round(users), errorRate: Math.round(rate * 100) / 100 } } }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function absorbRunbooks(incident: Incident, view: unknown): Incident {
  if (!Array.isArray(view)) return incident
  const done = new Map<string, boolean>()
  for (const runbook of view) {
    const steps: unknown = isRecord(runbook) ? runbook.steps : undefined
    if (!Array.isArray(steps)) continue
    for (const step of steps) {
      if (isRecord(step) && typeof step.id === "string" && typeof step.done === "boolean") done.set(step.id, step.done)
    }
  }
  return {
    ...incident,
    runbooks: incident.runbooks.map((runbook) => ({ ...runbook, steps: runbook.steps.map((step) => ({ ...step, done: done.get(step.id) ?? step.done })) })),
  }
}

export function runbookProgress(runbook: Runbook): { done: number; total: number; percent: number } {
  const done = runbook.steps.filter((step) => step.done).length
  return { done, total: runbook.steps.length, percent: Math.round((done / runbook.steps.length) * 100) }
}

export function impactSummary(impact: Impact): string {
  return `${impact.usersPercent}% of users affected, ${impact.errorRate}% error rate`
}

function clock(time: number): string {
  const date = new Date(time)
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

export function stakeholderUpdate(incident: Incident, now: number): string {
  const latest = incident.updates.at(-1)
  const next = incident.status === "resolved" ? "No further updates are planned; a postmortem will follow." : `Next update by ${clock(now + 30 * 60_000)}.`
  return [
    `### ${incident.severity} · ${incident.title}`,
    `**Status:** ${STATUS_LABEL[incident.status]} · **Duration:** ${formatDuration(elapsedSeconds(incident, now))}`,
    `**Affected:** ${incident.services.join(", ")} · ${impactSummary(incident.impact)}`,
    latest ? `**Latest (${clock(latest.at)}):** ${latest.text}` : "**Latest:** The team is investigating.",
    `**Commander:** ${incident.commander} · **Comms:** ${incident.comms}`,
    `_${next}_`,
  ].join("\n\n")
}

export function postmortemPrompt(incident: Incident, now: number): string {
  const timeline = incident.timeline.map((entry) => `- ${clock(entry.at)} ${entry.from ? `${STATUS_LABEL[entry.from]} → ` : ""}${STATUS_LABEL[entry.to]}${entry.note ? `: ${entry.note}` : ""}`)
  const updates = incident.updates.map((update) => `- ${clock(update.at)} [${STATUS_LABEL[update.status]}] ${update.text}`)
  const runbooks = incident.runbooks.flatMap((runbook) => runbook.steps.map((step) => `- [${step.done ? "x" : " "}] ${runbook.service}: ${step.label}`))
  return [
    `Draft a blameless postmortem for the incident "${incident.title}".`,
    [
      "## Facts",
      `- Severity: ${incident.severity} (${SEVERITY_MEANING[incident.severity]})`,
      `- Status: ${STATUS_LABEL[incident.status]}`,
      `- Duration: ${formatDuration(elapsedSeconds(incident, now))}`,
      `- Affected services: ${incident.services.join(", ")}`,
      `- Impact: ${impactSummary(incident.impact)}`,
      `- Roles: commander ${incident.commander}, comms ${incident.comms}, scribe ${incident.scribe}`,
    ].join("\n"),
    ["## Timeline", ...timeline].join("\n"),
    ["## Stakeholder updates", ...(updates.length > 0 ? updates : ["- none posted"])].join("\n"),
    ["## Runbook steps", ...runbooks].join("\n"),
    "Write sections for summary, customer impact, detection, response, root cause (mark hypotheses as such), what went well, what went poorly, and action items with an owner each. Look through the repository for code or config changes in the affected services that could explain the timeline.",
  ].join("\n\n")
}
