import type { SurfaceComponent, SurfaceMessage } from "@claxedo/plugin-api"
import {
  elapsedSeconds,
  formatDuration,
  RESPONDERS,
  runbookProgress,
  SERVICES,
  SEVERITIES,
  SEVERITY_MEANING,
  stakeholderUpdate,
  STATUS_LABEL,
  STATUSES,
  type Incident,
  type IncidentStatus,
  type Severity,
} from "./model"

export const CATALOG_ID = "https://claxedo.dev/a2ui/v0.9/catalog.json"
const VERSION = "v0.9"

type Binding = { path: string }
type Context = Record<string, Binding | string>
type DataValue = Extract<SurfaceMessage, { updateDataModel: unknown }>["updateDataModel"]["value"]
type ButtonOptions = { variant?: "primary" | "default" | "borderless"; icon?: Extract<SurfaceComponent, { component: "Button" }>["icon"] }

export type NoticeKey = "declare" | "status" | "update" | "impact"
export type Notice = { title: string; text: string }

function text(id: string, value: string | Binding, variant?: "caption" | "body"): SurfaceComponent {
  return variant ? { id, component: "Text", text: value, variant } : { id, component: "Text", text: value }
}

function button(id: string, label: string, name: string, context?: Context, options: ButtonOptions = {}): SurfaceComponent[] {
  return [{ id, component: "Button", child: `${id}-label`, action: { event: context ? { name, context } : { name } }, ...options }, text(`${id}-label`, label)]
}

function dropdown(id: string, label: string, path: string, options: readonly string[]): SurfaceComponent {
  return { id, component: "ChoicePicker", label, variant: "mutuallyExclusive", displayStyle: "dropdown", options: options.map((option) => ({ label: option, value: option })), value: { path } }
}

const RUNBOOK_CONTEXT: Context = { runbooks: { path: "/runbooks" } }

export function rootComponent(active: boolean): SurfaceComponent {
  return { id: "root", component: "Column", children: active ? ["header", "kpis", "status", "response", "postmortem-section"] : ["header", "declare-section"] }
}

export function headerComponent(active: boolean): SurfaceComponent {
  return active
    ? {
        id: "header",
        component: "Header",
        title: { path: "/incident/title" },
        subtitle: { path: "/incident/subtitle" },
        icon: "warning",
        badges: ["header-severity", "header-status"],
        actions: ["new-incident", "resolve"],
      }
    : { id: "header", component: "Header", title: "Incident commander", subtitle: "No open incident", icon: "warning", badges: ["header-status"] }
}

export function structureMessage(surfaceId: string, active: boolean): SurfaceMessage {
  return components(surfaceId, [rootComponent(active), headerComponent(active), updatesBody(false)])
}

const NOTICE_HOSTS: Record<NoticeKey, (shown: boolean) => SurfaceComponent> = {
  declare: (shown) => ({ id: "declare-body", component: "Column", children: ["declare-fields", "declare-services", "declare-roles", "severity-guide", ...(shown ? ["declare-notice"] : []), "declare-footer"] }),
  status: (shown) => ({ id: "status-body", component: "Column", children: ["status-fields", ...(shown ? ["status-notice"] : []), "status-footer"] }),
  update: (shown) => ({ id: "updates-tab", component: "Column", children: ["updates-body", "update-draft", ...(shown ? ["update-notice"] : []), "updates-footer", "stakeholder-preview"] }),
  impact: (shown) => ({ id: "impact-tab", component: "Column", children: ["impact-fields", ...(shown ? ["impact-notice"] : []), "impact-footer"] }),
}

export function noticeMessages(surfaceId: string, key: NoticeKey, notice: Notice | null, wasShown: boolean): SurfaceMessage[] {
  if (!notice) return wasShown ? [components(surfaceId, [NOTICE_HOSTS[key](false)])] : []
  const callout: SurfaceComponent = { id: `${key}-notice`, component: "Callout", tone: "danger", title: { path: `/notices/${key}/title` }, text: { path: `/notices/${key}/text` } }
  return [patch(surfaceId, `/notices/${key}`, notice), ...(wasShown ? [] : [components(surfaceId, [NOTICE_HOSTS[key](true), callout])])]
}

export function updatesBody(hasUpdates: boolean): SurfaceComponent {
  return hasUpdates
    ? { id: "updates-body", component: "List", children: { componentId: "update-row", path: "/updates" } }
    : { id: "updates-body", component: "EmptyState", title: "No updates posted", description: "Post the first stakeholder update within 15 minutes of declaring." }
}

export function postmortemStatus(busy: boolean): SurfaceComponent {
  return busy ? { id: "postmortem-status", component: "Spinner", label: "Starting the postmortem session…" } : text("postmortem-status", { path: "/postmortem/status" }, "caption")
}

function stat(id: string, label: string, value: string, caption: string): SurfaceComponent {
  return { id, component: "Stat", label, value: { path: value }, caption: { path: caption } }
}

export function incidentComponents(incident: Incident | null): SurfaceComponent[] {
  const active = incident !== null
  return [
    rootComponent(active),
    headerComponent(active),
    { id: "header-severity", component: "Badge", text: { path: "/incident/severity" }, variant: { path: "/incident/severityTone" } },
    { id: "header-status", component: "Badge", text: { path: "/incident/status" }, variant: { path: "/incident/statusTone" } },
    ...button("new-incident", "Close and declare another", "reset", undefined, { variant: "borderless", icon: "close" }),
    ...button("resolve", "Resolve incident", "resolve", { note: { path: "/transitionNote" }, ...RUNBOOK_CONTEXT }, { variant: "primary", icon: "check" }),

    { id: "declare-section", component: "Section", title: "Declare an incident", description: "Declare as soon as customers are affected. The clock starts when you do.", child: "declare-body" },
    NOTICE_HOSTS.declare(false),
    { id: "declare-fields", component: "Grid", columns: 2, children: ["declare-name", "declare-severity"] },
    { id: "declare-name", component: "TextField", label: "Incident title", value: { path: "/declare/title" } },
    {
      id: "declare-severity",
      component: "ChoicePicker",
      label: "Severity",
      variant: "mutuallyExclusive",
      displayStyle: "chips",
      options: SEVERITIES.map((severity) => ({ label: severity, value: severity })),
      value: { path: "/declare/severity" },
    },
    {
      id: "declare-services",
      component: "ChoicePicker",
      label: "Affected services",
      variant: "multipleSelection",
      displayStyle: "chips",
      options: SERVICES.map((service) => ({ label: service, value: service })),
      value: { path: "/declare/services" },
    },
    { id: "declare-roles", component: "Grid", columns: 3, children: ["declare-commander", "declare-comms", "declare-scribe"] },
    dropdown("declare-commander", "Commander", "/declare/commander", RESPONDERS),
    dropdown("declare-comms", "Comms lead", "/declare/comms", RESPONDERS),
    dropdown("declare-scribe", "Scribe", "/declare/scribe", RESPONDERS),
    { id: "severity-guide", component: "Collapsible", title: "Severity guide", child: "severity-meanings" },
    { id: "severity-meanings", component: "KeyValue", items: SEVERITIES.map((severity) => ({ label: severity, value: capitalize(SEVERITY_MEANING[severity]) })) },
    { id: "declare-footer", component: "Footer", end: ["declare"] },
    ...button("declare", "Declare incident", "declare", { form: { path: "/declare" } }, { variant: "primary", icon: "warning" }),

    { id: "kpis", component: "Grid", columns: 4, children: ["kpi-elapsed", "kpi-users", "kpi-errors", "kpi-updates"] },
    stat("kpi-elapsed", "Elapsed", "/elapsed", "/incident/declared"),
    stat("kpi-users", "Users affected", "/incident/users/value", "/incident/users/caption"),
    stat("kpi-errors", "Error rate", "/incident/errors/value", "/incident/errors/caption"),
    stat("kpi-updates", "Stakeholder updates", "/incident/updates/value", "/incident/updates/caption"),

    { id: "status", component: "Section", title: "Status", description: "Move the incident forward and note why. Every change lands in the timeline.", child: "status-body" },
    NOTICE_HOSTS.status(false),
    { id: "status-fields", component: "Grid", columns: 2, children: ["status-choice", "status-note"] },
    {
      id: "status-choice",
      component: "ChoicePicker",
      label: "New status",
      variant: "mutuallyExclusive",
      displayStyle: "chips",
      options: STATUSES.map((status) => ({ label: STATUS_LABEL[status], value: status })),
      value: { path: "/statusChoice" },
    },
    { id: "status-note", component: "TextField", label: "Transition note", value: { path: "/transitionNote" } },
    { id: "status-footer", component: "Footer", end: ["update-status"] },
    ...button("update-status", "Update status", "transition", { status: { path: "/statusChoice" }, note: { path: "/transitionNote" }, ...RUNBOOK_CONTEXT }, { icon: "arrowForward" }),

    { id: "response", component: "Section", title: "Response", child: "response-tabs" },
    {
      id: "response-tabs",
      component: "Tabs",
      tabs: [
        { title: "Timeline", child: "timeline" },
        { title: "Runbooks", child: "runbooks-tab" },
        { title: "Updates", child: "updates-tab" },
        { title: "Impact", child: "impact-tab" },
      ],
    },
    { id: "timeline", component: "List", children: { componentId: "timeline-row", path: "/timeline" } },
    { id: "timeline-row", component: "ListItem", title: { path: "change" }, subtitle: { path: "detail" }, icon: "event", meta: ["timeline-elapsed"] },
    { id: "timeline-elapsed", component: "Badge", text: { path: "elapsed" } },

    { id: "runbooks-tab", component: "Column", children: ["runbooks", "runbooks-footer"] },
    { id: "runbooks", component: "List", children: { componentId: "runbook", path: "/runbooks" } },
    { id: "runbook", component: "Section", variant: "plain", title: { path: "title" }, description: { path: "progress" }, child: "runbook-steps" },
    { id: "runbook-steps", component: "Column", children: { componentId: "runbook-step", path: "steps" } },
    { id: "runbook-step", component: "CheckBox", label: { path: "label" }, value: { path: "done" } },
    { id: "runbooks-footer", component: "Footer", end: ["save-runbooks"] },
    ...button("save-runbooks", "Save runbook progress", "saveRunbooks", RUNBOOK_CONTEXT, { icon: "check" }),

    NOTICE_HOSTS.update(false),
    updatesBody((incident?.updates.length ?? 0) > 0),
    { id: "update-row", component: "ListItem", title: { path: "text" }, subtitle: { path: "time" }, icon: "send", meta: ["update-status-badge"] },
    { id: "update-status-badge", component: "Badge", text: { path: "status" }, variant: { path: "tone" } },
    { id: "update-draft", component: "TextField", label: "Status update", variant: "longText", value: { path: "/draftUpdate" } },
    { id: "updates-footer", component: "Footer", end: ["post-update"] },
    ...button("post-update", "Post update", "postUpdate", { text: { path: "/draftUpdate" } }, { icon: "send" }),
    { id: "stakeholder-preview", component: "Collapsible", title: "Stakeholder summary", child: "stakeholder" },
    { id: "stakeholder", component: "Markdown", text: { path: "/stakeholder" } },

    NOTICE_HOSTS.impact(false),
    { id: "impact-fields", component: "Grid", columns: 2, children: ["impact-users", "impact-errors"] },
    { id: "impact-users", component: "TextField", label: "Users affected (%)", variant: "number", value: { path: "/impact/usersPercent" } },
    { id: "impact-errors", component: "TextField", label: "Error rate (%)", variant: "number", value: { path: "/impact/errorRate" } },
    { id: "impact-footer", component: "Footer", end: ["record-impact"] },
    ...button("record-impact", "Record impact", "recordImpact", { usersPercent: { path: "/impact/usersPercent" }, errorRate: { path: "/impact/errorRate" } }, { icon: "check" }),

    {
      id: "postmortem-section",
      component: "Section",
      title: "Postmortem",
      description: "An agent drafts a blameless postmortem from the timeline, updates and runbooks.",
      actions: ["postmortem"],
      child: "postmortem-status",
    },
    ...button("postmortem", "Start postmortem", "postmortem", RUNBOOK_CONTEXT, { icon: "play" }),
    postmortemStatus(false),
  ]
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function clock(time: number): string {
  const date = new Date(time)
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`
}

export const EMPTY_DECLARE = { title: "", severity: ["SEV2"], services: [], commander: ["Priya"], comms: ["Ana"], scribe: ["Lee"] }

export const SEVERITY_TONE: Record<Severity, string> = { SEV1: "danger", SEV2: "warning", SEV3: "accent", SEV4: "neutral" }
export const STATUS_TONE: Record<IncidentStatus, string> = { investigating: "danger", identified: "warning", monitoring: "accent", resolved: "success" }

const IDLE_FIGURE = { value: "—", caption: "No open incident" }

export function summaryData(incident: Incident | null) {
  if (!incident) {
    return { title: "", subtitle: "", severity: "No incident", severityTone: "neutral", status: "All clear", statusTone: "success", declared: "", users: IDLE_FIGURE, errors: IDLE_FIGURE, updates: IDLE_FIGURE }
  }
  const latest = incident.updates.at(-1)
  const count = incident.updates.length
  return {
    title: incident.title,
    subtitle: `Commander ${incident.commander} · Comms ${incident.comms} · Scribe ${incident.scribe}`,
    severity: incident.severity,
    severityTone: SEVERITY_TONE[incident.severity],
    status: STATUS_LABEL[incident.status],
    statusTone: STATUS_TONE[incident.status],
    declared: `Declared at ${clock(incident.declaredAt)}${incident.resolvedAt ? ` · resolved at ${clock(incident.resolvedAt)}` : ""}`,
    users: { value: `${incident.impact.usersPercent}%`, caption: "Estimated share of all users" },
    errors: { value: `${incident.impact.errorRate}%`, caption: `Requests to ${incident.services.join(", ")}` },
    updates: { value: count === 0 ? "None" : String(count), caption: latest ? `Last posted at ${clock(latest.at)}` : "Post one within 15 minutes" },
  }
}

export function elapsedText(incident: Incident | null, now: number): string {
  return formatDuration(incident ? elapsedSeconds(incident, now) : 0)
}

export function timelineData(incident: Incident | null) {
  return (incident?.timeline ?? []).map((entry) => {
    const time = clock(entry.at)
    return {
      time,
      elapsed: `T+${formatDuration(Math.floor((entry.at - (incident?.declaredAt ?? entry.at)) / 1000))}`,
      change: entry.from ? `${STATUS_LABEL[entry.from]} → ${STATUS_LABEL[entry.to]}` : `Declared · ${STATUS_LABEL[entry.to]}`,
      note: entry.note,
      detail: entry.note ? `${time} · ${entry.note}` : time,
    }
  })
}

export function runbooksData(incident: Incident | null) {
  return (incident?.runbooks ?? []).map((runbook) => {
    const progress = runbookProgress(runbook)
    return {
      service: runbook.service,
      title: `${runbook.service} runbook`,
      progress: `${progress.done} of ${progress.total} steps done`,
      steps: runbook.steps.map((step) => ({ id: step.id, label: step.label, done: step.done })),
    }
  })
}

export function updatesData(incident: Incident | null) {
  return [...(incident?.updates ?? [])]
    .reverse()
    .map((update) => ({ id: update.id, time: `Posted at ${clock(update.at)}`, status: STATUS_LABEL[update.status], tone: STATUS_TONE[update.status], text: update.text }))
}

const EMPTY_NOTICE: Notice = { title: "", text: "" }

export function incidentModel(incident: Incident | null, now: number) {
  return {
    declare: EMPTY_DECLARE,
    incident: summaryData(incident),
    elapsed: elapsedText(incident, now),
    statusChoice: [incident?.status ?? "investigating"],
    transitionNote: "",
    timeline: timelineData(incident),
    runbooks: runbooksData(incident),
    draftUpdate: "",
    updates: updatesData(incident),
    stakeholder: incident ? stakeholderUpdate(incident, now) : "",
    impact: { usersPercent: String(incident?.impact.usersPercent ?? 0), errorRate: String(incident?.impact.errorRate ?? 0) },
    postmortem: { status: "No postmortem session yet." },
    notices: { declare: EMPTY_NOTICE, status: EMPTY_NOTICE, update: EMPTY_NOTICE, impact: EMPTY_NOTICE },
  }
}

export function patch(surfaceId: string, path: string, value: DataValue): SurfaceMessage {
  return { version: VERSION, updateDataModel: { surfaceId, path, value } }
}

export function components(surfaceId: string, list: SurfaceComponent[]): SurfaceMessage {
  return { version: VERSION, updateComponents: { surfaceId, components: list } }
}

export function openMessages(surfaceId: string, incident: Incident | null, now: number): SurfaceMessage[] {
  return [
    { version: VERSION, createSurface: { surfaceId, catalogId: CATALOG_ID } },
    components(surfaceId, incidentComponents(incident)),
    patch(surfaceId, "/", incidentModel(incident, now)),
  ]
}

export function incidentMessages(surfaceId: string, incident: Incident | null, now: number): SurfaceMessage[] {
  return [
    patch(surfaceId, "/incident", summaryData(incident)),
    patch(surfaceId, "/elapsed", elapsedText(incident, now)),
    patch(surfaceId, "/statusChoice", [incident?.status ?? "investigating"]),
    patch(surfaceId, "/timeline", timelineData(incident)),
    patch(surfaceId, "/runbooks", runbooksData(incident)),
    patch(surfaceId, "/updates", updatesData(incident)),
    patch(surfaceId, "/stakeholder", incident ? stakeholderUpdate(incident, now) : ""),
  ]
}
