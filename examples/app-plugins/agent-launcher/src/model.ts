export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

export type SessionKey = { readonly sessionId: string; readonly workspaceId: string }

export type AgentStatus = "idle" | "running" | "running_in_background" | "waiting" | "interrupted" | "failed"

export type LaunchStatus = AgentStatus | "launching" | "launch_failed"

export type TemplateVariable = { readonly name: string; readonly label: string }

export type LaunchTemplate = {
  readonly id: string
  readonly label: string
  readonly body: string
  readonly variables: readonly TemplateVariable[]
}

export type VariableValue = { readonly name: string; readonly label: string; readonly value: string }

export type Project = { readonly id: string; readonly name: string }

export type Launch = {
  readonly key: string
  readonly title: string
  readonly projectName: string
  readonly launchedAt: string
  readonly status: LaunchStatus
  readonly ref?: SessionKey
  readonly error?: string
}

export type LaunchForm = {
  readonly templateId: string
  readonly projectId: string
  readonly prompt: string
  readonly title: string
  readonly batch: number
  readonly variables: readonly VariableValue[]
}

export const MAX_BATCH = 5

export const CUSTOM_TEMPLATE_ID = "custom"

export const TEMPLATES: readonly LaunchTemplate[] = [
  {
    id: "fix-tests",
    label: "Fix failing tests",
    body: "The tests in {testPath} are failing. Run them, find the root cause, and fix the implementation rather than the tests. Re-run the suite until it passes and summarise what was wrong.",
    variables: [{ name: "testPath", label: "Test path" }],
  },
  {
    id: "write-docs",
    label: "Write docs",
    body: "Write documentation for {module} aimed at {audience}. Cover its purpose, its public API with one example per entry point, and the failure modes a caller must handle.",
    variables: [
      { name: "module", label: "Module" },
      { name: "audience", label: "Audience" },
    ],
  },
  {
    id: "review-diff",
    label: "Review diff",
    body: "Review the diff between {base} and the working tree. Report correctness bugs first, then risky behaviour changes, then readability. Cite the file and line for every finding.",
    variables: [{ name: "base", label: "Base branch" }],
  },
  {
    id: "refactor",
    label: "Refactor module",
    body: "Refactor {module} so that {goal}. Keep behaviour identical and the public API stable, and run the tests after each step.",
    variables: [
      { name: "module", label: "Module" },
      { name: "goal", label: "Goal" },
    ],
  },
  { id: CUSTOM_TEMPLATE_ID, label: "Custom", body: "", variables: [] },
]

export const STATUS_ORDER: readonly LaunchStatus[] = [
  "launching",
  "running",
  "running_in_background",
  "waiting",
  "idle",
  "interrupted",
  "failed",
  "launch_failed",
]

export const STATUS_LABELS: Readonly<Record<LaunchStatus, string>> = {
  launching: "Launching",
  running: "Running",
  running_in_background: "In background",
  waiting: "Needs input",
  idle: "Idle",
  interrupted: "Interrupted",
  failed: "Failed",
  launch_failed: "Launch failed",
}

export function templateById(id: string): LaunchTemplate {
  return TEMPLATES.find((template) => template.id === id) ?? TEMPLATES[TEMPLATES.length - 1]!
}

export function placeholders(text: string): string[] {
  const names: string[] = []
  for (const match of text.matchAll(/\{([A-Za-z][\w-]*)\}/g)) {
    const name = match[1]!
    if (!names.includes(name)) names.push(name)
  }
  return names
}

export function fillTemplate(body: string, values: readonly VariableValue[]): string {
  return body.replace(/\{([A-Za-z][\w-]*)\}/g, (whole, name: string) => {
    const value = values.find((variable) => variable.name === name)?.value.trim()
    return value ? value : whole
  })
}

export function variablesFor(template: LaunchTemplate, previous: readonly VariableValue[]): VariableValue[] {
  return template.variables.map((variable) => ({
    name: variable.name,
    label: variable.label,
    value: previous.find((old) => old.name === variable.name)?.value ?? "",
  }))
}

export function clampBatch(value: unknown): number {
  const count = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 1
  return Math.min(MAX_BATCH, Math.max(1, count))
}

export function batchTitles(title: string, count: number, fallback: string): string[] {
  const base = title.trim() || fallback
  return count === 1 ? [base] : Array.from({ length: count }, (_, index) => `${base} #${index + 1}`)
}

export function validateLaunch(form: LaunchForm, projects: readonly Project[]): string[] {
  const errors: string[] = []
  if (!projects.some((project) => project.id === form.projectId)) errors.push("Choose a project.")
  if (!form.prompt.trim()) errors.push("Write a prompt.")
  const declared = templateById(form.templateId).variables.map((variable) => variable.name)
  const missing = placeholders(form.prompt).filter((name) => declared.includes(name))
  if (missing.length > 0) errors.push(`Fill in ${missing.map((name) => `{${name}}`).join(", ")}.`)
  return errors
}

function text(value: Json | undefined): string {
  return typeof value === "string" ? value : ""
}

function firstText(value: Json | undefined): string {
  return Array.isArray(value) ? text(value[0]) : text(value)
}

export function readVariables(value: Json | undefined): VariableValue[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) =>
    item && typeof item === "object" && !Array.isArray(item) && typeof item.name === "string"
      ? [{ name: item.name, label: text(item.label), value: text(item.value) }]
      : [],
  )
}

export function readLaunchForm(context: Readonly<Record<string, Json>>): LaunchForm {
  return {
    templateId: text(context.template),
    projectId: firstText(context.project),
    prompt: text(context.prompt),
    title: text(context.title),
    batch: clampBatch(context.batch),
    variables: readVariables(context.variables),
  }
}

export function refreshStatuses(
  launches: readonly Launch[],
  read: (ref: SessionKey) => AgentStatus,
): { launches: Launch[]; changed: number[] } {
  const changed: number[] = []
  const next = launches.map((launch, index) => {
    if (!launch.ref) return launch
    const status = read(launch.ref)
    if (status === launch.status) return launch
    changed.push(index)
    return { ...launch, status }
  })
  return { launches: next, changed }
}

export type StatusCount = { readonly status: string; readonly count: number }

export function statusSummary(launches: readonly Launch[]): StatusCount[] {
  return STATUS_ORDER.flatMap((status) => {
    const count = launches.filter((launch) => launch.status === status).length
    return count > 0 ? [{ status: STATUS_LABELS[status], count }] : []
  })
}

export function summaryLine(launches: readonly Launch[]): string {
  if (launches.length === 0) return "Nothing launched yet"
  const active = launches.filter((launch) => launch.status === "running" || launch.status === "running_in_background").length
  const attention = launches.filter((launch) => launch.status === "waiting").length
  return `${launches.length} launched · ${active} active · ${attention} need input`
}

export type LaunchRow = {
  readonly key: string
  readonly title: string
  readonly status: string
  readonly detail: string
}

export function launchRow(launch: Launch): LaunchRow {
  const where = `${launch.projectName} · ${launch.launchedAt}`
  return {
    key: launch.key,
    title: launch.title,
    status: STATUS_LABELS[launch.status],
    detail: launch.error ? `${where} · ${launch.error}` : where,
  }
}

export function projectsSignature(projects: readonly Project[]): string {
  return projects.map((project) => `${project.id}\u0000${project.name}`).join("\u0001")
}
