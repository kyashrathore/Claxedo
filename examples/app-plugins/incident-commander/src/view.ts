import type { SurfaceComponent, SurfaceMessage } from "@claxedo/plugin-api"
import {
  elapsedSeconds,
  formatDuration,
  impactSummary,
  RESPONDERS,
  runbookProgress,
  SERVICES,
  SEVERITIES,
  SEVERITY_MEANING,
  stakeholderUpdate,
  STATUS_LABEL,
  STATUSES,
  type Incident,
} from "./model"

export const CATALOG_ID = "https://claxedo.dev/a2ui/v0.9/catalog.json"
const VERSION = "v0.9"

type Binding = { path: string }
type Context = Record<string, Binding | string>
type DataValue = Extract<SurfaceMessage, { updateDataModel: unknown }>["updateDataModel"]["value"]

function text(id: string, value: string | Binding, variant?: "h1" | "h2" | "h3" | "h4" | "h5" | "caption" | "body"): SurfaceComponent {
  return variant ? { id, component: "Text", text: value, variant } : { id, component: "Text", text: value }
}

function button(id: string, label: string, name: string, context?: Context, variant?: "primary" | "default" | "borderless"): SurfaceComponent[] {
  return [
    { id, component: "Button", child: `${id}-label`, action: { event: context ? { name, context } : { name } }, ...(variant ? { variant } : {}) },
    text(`${id}-label`, label),
  ]
}

function dropdown(id: string, label: string, path: string, options: readonly string[]): SurfaceComponent {
  return {
    id,
    component: "ChoicePicker",
    label,
    variant: "mutuallyExclusive",
    displayStyle: "dropdown",
    options: options.map((option) => ({ label: option, value: option })),
    value: { path },
    weight: 1,
  }
}

const RUNBOOK_CONTEXT: Context = { runbooks: { path: "/runbooks" } }

export function bodyComponent(active: boolean): SurfaceComponent {
  return { id: "body", component: "Column", children: active ? ["summary-card", "incident-tabs", "incident-actions"] : ["declare-card"] }
}

export function updatesBody(hasUpdates: boolean): SurfaceComponent {
  return hasUpdates
    ? { id: "updates-body", component: "List", children: { componentId: "update-card", path: "/updates" } }
    : { id: "updates-body", component: "EmptyState", title: "No updates posted", description: "Post the first stakeholder update within 15 minutes of declaring." }
}

export function postmortemStatus(busy: boolean): SurfaceComponent {
  return busy
    ? { id: "postmortem-status", component: "Spinner", label: "Starting the postmortem session" }
    : { ...text("postmortem-status", { path: "/postmortem/status" }, "caption"), weight: 1 }
}

export function incidentComponents(incident: Incident | null): SurfaceComponent[] {
  return [
    { id: "root", component: "Column", children: ["header", "body"] },
    { id: "header", component: "Row", align: "center", children: ["header-icon", "header-title", "header-severity", "header-status", "header-elapsed"] },
    { id: "header-icon", component: "Icon", name: "warning" },
    { ...text("header-title", "Incident commander", "h2"), weight: 1 },
    { id: "header-severity", component: "Badge", text: { path: "/incident/severity" } },
    { id: "header-status", component: "Badge", text: { path: "/incident/status" }, variant: "accent" },
    text("header-elapsed", { path: "/elapsed" }, "h3"),
    bodyComponent(incident !== null),

    { id: "declare-card", component: "Card", child: "declare-column" },
    { id: "declare-column", component: "Column", children: ["declare-title", "declare-name", "declare-severity", "declare-severity-help", "declare-services", "declare-roles", "declare"] },
    text("declare-title", "Declare an incident", "h3"),
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
    text("declare-severity-help", SEVERITIES.map((severity) => `${severity}: ${SEVERITY_MEANING[severity]}`).join(" · "), "caption"),
    {
      id: "declare-services",
      component: "ChoicePicker",
      label: "Affected services",
      variant: "multipleSelection",
      displayStyle: "chips",
      options: SERVICES.map((service) => ({ label: service, value: service })),
      value: { path: "/declare/services" },
    },
    { id: "declare-roles", component: "Row", children: ["declare-commander", "declare-comms", "declare-scribe"] },
    dropdown("declare-commander", "Commander", "/declare/commander", RESPONDERS),
    dropdown("declare-comms", "Comms lead", "/declare/comms", RESPONDERS),
    dropdown("declare-scribe", "Scribe", "/declare/scribe", RESPONDERS),
    ...button("declare", "Declare incident", "declare", { form: { path: "/declare" } }, "primary"),

    { id: "summary-card", component: "Card", child: "summary-column" },
    { id: "summary-column", component: "Column", children: ["summary-title", "summary-roles", "summary-declared", "summary-impact"] },
    text("summary-title", { path: "/incident/title" }, "h3"),
    text("summary-roles", { path: "/incident/roles" }, "body"),
    text("summary-declared", { path: "/incident/declared" }, "caption"),
    text("summary-impact", { path: "/incident/impact" }, "caption"),

    {
      id: "incident-tabs",
      component: "Tabs",
      tabs: [
        { title: "Status", child: "status-tab" },
        { title: "Runbooks", child: "runbooks-tab" },
        { title: "Updates", child: "updates-tab" },
        { title: "Impact", child: "impact-tab" },
      ],
    },

    { id: "status-tab", component: "Column", children: ["status-row", "timeline"] },
    { id: "status-row", component: "Row", align: "end", children: ["status-choice", "status-note", "update-status"] },
    {
      id: "status-choice",
      component: "ChoicePicker",
      label: "Status",
      variant: "mutuallyExclusive",
      displayStyle: "chips",
      options: STATUSES.map((status) => ({ label: STATUS_LABEL[status], value: status })),
      value: { path: "/statusChoice" },
    },
    { id: "status-note", component: "TextField", label: "Transition note", value: { path: "/transitionNote" }, weight: 1 },
    ...button("update-status", "Update status", "transition", { status: { path: "/statusChoice" }, note: { path: "/transitionNote" }, ...RUNBOOK_CONTEXT }, "primary"),
    {
      id: "timeline",
      component: "Table",
      columns: [
        { key: "time", title: "Time" },
        { key: "elapsed", title: "T+" },
        { key: "change", title: "Change" },
        { key: "note", title: "Note" },
      ],
      rows: { path: "/timeline" },
    },

    { id: "runbooks-tab", component: "Column", children: ["runbooks", "save-runbooks"] },
    { id: "runbooks", component: "List", children: { componentId: "runbook", path: "/runbooks" } },
    { id: "runbook", component: "Collapsible", title: { path: "title" }, child: "runbook-body", open: true },
    { id: "runbook-body", component: "Column", children: ["runbook-progress", "runbook-steps"] },
    { id: "runbook-progress", component: "Progress", value: { path: "percent" }, max: 100 },
    { id: "runbook-steps", component: "Column", children: { componentId: "runbook-step", path: "steps" } },
    { id: "runbook-step", component: "CheckBox", label: { path: "label" }, value: { path: "done" } },
    ...button("save-runbooks", "Save runbook progress", "saveRunbooks", RUNBOOK_CONTEXT),

    { id: "updates-tab", component: "Column", children: ["update-draft", "post-update", "updates-body", "updates-divider", "stakeholder-title", "stakeholder"] },
    { id: "update-draft", component: "TextField", label: "Status update", variant: "longText", value: { path: "/draftUpdate" } },
    ...button("post-update", "Post update", "postUpdate", { text: { path: "/draftUpdate" } }, "primary"),
    updatesBody((incident?.updates.length ?? 0) > 0),
    { id: "update-card", component: "Card", child: "update-column" },
    { id: "update-column", component: "Column", children: ["update-header", "update-text"] },
    text("update-header", { path: "header" }, "caption"),
    text("update-text", { path: "text" }, "body"),
    { id: "updates-divider", component: "Divider" },
    text("stakeholder-title", "Stakeholder update", "h4"),
    { id: "stakeholder", component: "Markdown", text: { path: "/stakeholder" } },

    { id: "impact-tab", component: "Column", children: ["impact-users", "impact-errors", "record-impact"] },
    { id: "impact-users", component: "Slider", label: "Users affected (%)", min: 0, max: 100, step: 1, value: { path: "/impact/usersPercent" } },
    { id: "impact-errors", component: "TextField", label: "Error rate (%)", variant: "number", value: { path: "/impact/errorRate" } },
    ...button("record-impact", "Record impact", "recordImpact", { usersPercent: { path: "/impact/usersPercent" }, errorRate: { path: "/impact/errorRate" } }),

    { id: "incident-actions", component: "Row", align: "center", children: ["resolve", "postmortem", "postmortem-status", "new-incident"] },
    ...button("resolve", "Resolve incident", "resolve", { note: { path: "/transitionNote" }, ...RUNBOOK_CONTEXT }, "primary"),
    ...button("postmortem", "Start postmortem with an agent", "postmortem", RUNBOOK_CONTEXT),
    postmortemStatus(false),
    ...button("new-incident", "Close and declare another", "reset", undefined, "borderless"),
  ]
}

function clock(time: number): string {
  const date = new Date(time)
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`
}

export const EMPTY_DECLARE = { title: "", severity: ["SEV2"], services: [], commander: ["Priya"], comms: ["Ana"], scribe: ["Lee"] }

export function summaryData(incident: Incident | null) {
  if (!incident) return { title: "", severity: "No incident", status: "All clear", roles: "", declared: "", impact: "" }
  return {
    title: incident.title,
    severity: incident.severity,
    status: STATUS_LABEL[incident.status],
    roles: `Commander ${incident.commander} · Comms ${incident.comms} · Scribe ${incident.scribe}`,
    declared: `Declared at ${clock(incident.declaredAt)}${incident.resolvedAt ? ` · resolved at ${clock(incident.resolvedAt)}` : ""} · ${incident.services.join(", ")}`,
    impact: impactSummary(incident.impact),
  }
}

export function elapsedText(incident: Incident | null, now: number): string {
  return formatDuration(incident ? elapsedSeconds(incident, now) : 0)
}

export function timelineData(incident: Incident | null) {
  return (incident?.timeline ?? []).map((entry) => ({
    time: clock(entry.at),
    elapsed: formatDuration(Math.floor((entry.at - (incident?.declaredAt ?? entry.at)) / 1000)),
    change: entry.from ? `${STATUS_LABEL[entry.from]} → ${STATUS_LABEL[entry.to]}` : `Declared · ${STATUS_LABEL[entry.to]}`,
    note: entry.note,
  }))
}

export function runbooksData(incident: Incident | null) {
  return (incident?.runbooks ?? []).map((runbook) => {
    const progress = runbookProgress(runbook)
    return {
      service: runbook.service,
      title: `${runbook.service} runbook (${progress.done}/${progress.total})`,
      percent: progress.percent,
      steps: runbook.steps.map((step) => ({ id: step.id, label: step.label, done: step.done })),
    }
  })
}

export function updatesData(incident: Incident | null) {
  return [...(incident?.updates ?? [])].reverse().map((update) => ({ id: update.id, header: `${clock(update.at)} · ${STATUS_LABEL[update.status]}`, text: update.text }))
}

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
    impact: { usersPercent: incident?.impact.usersPercent ?? 0, errorRate: String(incident?.impact.errorRate ?? 0) },
    postmortem: { status: "No postmortem session yet" },
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
