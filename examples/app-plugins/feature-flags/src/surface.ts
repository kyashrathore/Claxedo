import type { SurfaceComponent, SurfaceMessage } from "@claxedo/plugin-api"
import {
  ENVIRONMENTS,
  FLAG_KEY_PATTERN,
  ROLLOUT_STEP,
  SEGMENTS,
  TEAMS,
  audienceLabel,
  changeSummary,
  describeChange,
  effectiveSetting,
  envSummary,
  envTitle,
  envTone,
  pendingChanges,
  pendingDiff,
  promotionWarnings,
  searchFlags,
  stateBadge,
  teamLabel,
  type EnvId,
  type FlagStore,
} from "./model"

export const SURFACE_CATALOG_ID = "https://claxedo.dev/a2ui/v0.9/catalog.json"
const VERSION = "v0.9" as const

type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

type ButtonVariant = "default" | "primary" | "borderless"

type IconName = Extract<SurfaceComponent, { component: "Button" }>["icon"]

function when<Item extends Json>(condition: boolean, item: Item): Item[] {
  return condition ? [item] : []
}

function text(id: string, value: string, variant?: "caption" | "body"): SurfaceComponent {
  return variant ? { id, component: "Text", text: value, variant } : { id, component: "Text", text: value }
}

export const EDIT_CONTEXT = Object.fromEntries(ENVIRONMENTS.map((env) => [env.id, { path: `/envs/${env.id}/rows` }]))

function button(id: string, label: string, name: string, options: { variant?: ButtonVariant; icon?: IconName; context?: Record<string, { path: string } | string> } = {}): SurfaceComponent[] {
  return [
    {
      id,
      component: "Button",
      ...(options.variant ? { variant: options.variant } : {}),
      ...(options.icon ? { icon: options.icon } : {}),
      child: `${id}-label`,
      action: { event: { name, context: { ...EDIT_CONTEXT, ...options.context } } },
    },
    text(`${id}-label`, label),
  ]
}

function envTab(env: EnvId): SurfaceComponent[] {
  const kill = env === "prod" ? ["kill"] : []
  return [
    { id: `env-${env}`, component: "Column", children: [`env-${env}-empty`, `env-${env}-list`, ...kill] },
    { id: `env-${env}-list`, component: "List", children: { componentId: "flag-row", path: `/envs/${env}/rows` } },
    { id: `env-${env}-empty`, component: "List", children: { componentId: "empty-state", path: `/envs/${env}/empty` } },
  ]
}

export function createBody(error: boolean): SurfaceComponent {
  return { id: "create-body", component: "Column", children: ["create-fields", "draft-description", "draft-hint", ...(error ? ["create-error"] : []), "create-footer"] }
}

export function flagComponents(): SurfaceComponent[] {
  return [
    { id: "root", component: "Column", children: ["header", "kpis", "flags", "pending", "create", "audit"] },

    { id: "header", component: "Header", title: "Feature flags", subtitle: { path: "/header/subtitle" }, icon: "settings", badges: ["header-pending"], actions: ["stage", "apply"] },
    { id: "header-pending", component: "Badge", text: { path: "/header/pending/label" }, variant: { path: "/header/pending/tone" } },
    ...button("stage", "Stage edits", "stage", { icon: "upload" }),
    ...button("apply", "Review & apply", "apply", { variant: "primary", icon: "check" }),

    { id: "kpis", component: "Grid", columns: 3, children: ENVIRONMENTS.map((env) => `kpi-${env.id}`) },
    ...ENVIRONMENTS.map((env): SurfaceComponent => ({ id: `kpi-${env.id}`, component: "Stat", label: env.title, value: { path: `/kpis/${env.id}/value` }, caption: { path: `/kpis/${env.id}/caption` } })),

    { id: "flags", component: "Section", title: "Flags", description: { path: "/search/summary" }, actions: ["search-clear", "search"], child: "flags-body" },
    { id: "flags-body", component: "Column", children: ["search-field", "tabs"] },
    { id: "search-field", component: "TextField", label: "Search flags", value: { path: "/search/query" } },
    ...button("search", "Search", "search", { icon: "search", context: { query: { path: "/search/query" } } }),
    ...button("search-clear", "Clear search", "clearSearch", { variant: "borderless" }),
    { id: "tabs", component: "Tabs", tabs: ENVIRONMENTS.map((env) => ({ title: env.title, child: `env-${env.id}` })) },
    ...ENVIRONMENTS.flatMap((env) => envTab(env.id)),
    { id: "empty-state", component: "EmptyState", title: { path: "title" }, description: { path: "description" } },

    { id: "flag-row", component: "Column", children: ["flag-item", "flag-tuning", "flag-divider"] },
    {
      id: "flag-item",
      component: "ListItem",
      title: { path: "key" },
      subtitle: { path: "description" },
      meta: ["flag-state", "flag-owner", "flag-pending"],
      primaryAction: "flag-undo-slot",
    },
    { id: "flag-state", component: "Badge", text: { path: "state" }, variant: { path: "stateTone" } },
    { id: "flag-owner", component: "Badge", text: { path: "owner" } },
    { id: "flag-pending", component: "List", direction: "horizontal", children: { componentId: "flag-pending-badge", path: "pending" } },
    { id: "flag-pending-badge", component: "Badge", variant: "warning", text: { path: "text" } },
    { id: "flag-undo-slot", component: "List", direction: "horizontal", children: { componentId: "flag-undo", path: "undo" } },
    ...button("flag-undo", "Undo edit", "undo", { context: { env: { path: "env" }, key: { path: "key" } } }),
    { id: "flag-enabled", component: "Switch", label: "Enabled", value: { path: "enabled" } },
    { id: "flag-tuning", component: "Collapsible", title: { path: "tuning" }, child: "flag-tuning-body" },
    { id: "flag-tuning-body", component: "Column", children: ["flag-enabled", "flag-tuning-fields", "flag-applied"] },
    { id: "flag-tuning-fields", component: "Grid", columns: 2, children: ["flag-rollout", "flag-segments"] },
    { id: "flag-rollout", component: "Slider", label: "Rollout %", min: 0, max: 100, step: ROLLOUT_STEP, value: { path: "rollout" } },
    {
      id: "flag-segments",
      component: "ChoicePicker",
      label: "Targeting",
      variant: "multipleSelection",
      displayStyle: "chips",
      options: SEGMENTS.map((segment) => ({ label: segment.label, value: segment.id })),
      value: { path: "segments" },
    },
    { id: "flag-applied", component: "Text", variant: "caption", text: { path: "applied" } },
    { id: "flag-divider", component: "Divider" },

    { id: "kill", component: "Section", variant: "plain", title: "Production kill switch", description: { path: "/kill" }, actions: ["kill-button"], child: "kill-help" },
    text("kill-help", "Turns every production flag off at once, skipping review. Staged production edits are discarded; rollout and targeting are kept for re-enabling.", "caption"),
    ...button("kill-button", "Disable all production flags", "killProd", { icon: "warning" }),

    { id: "pending", component: "Section", title: { path: "/pending/title" }, description: { path: "/pending/summary" }, actions: ["revert"], child: "pending-body" },
    ...button("revert", "Revert pending", "revert", { variant: "borderless" }),
    { id: "pending-body", component: "Column", children: ["pending-empty", "pending-warnings", "pending-list", "pending-diff"] },
    { id: "pending-empty", component: "List", children: { componentId: "empty-state", path: "/pending/empty" } },
    { id: "pending-warnings", component: "List", children: { componentId: "pending-warning", path: "/pending/warnings" } },
    { id: "pending-warning", component: "Callout", tone: "warning", title: { path: "title" }, text: { path: "text" } },
    { id: "pending-list", component: "List", children: { componentId: "change", path: "/pending/changes" } },
    { id: "change", component: "ListItem", title: { path: "key" }, subtitle: { path: "description" }, meta: ["change-env"], primaryAction: "change-undo" },
    { id: "change-env", component: "Badge", text: { path: "envTitle" }, variant: { path: "envTone" } },
    ...button("change-undo", "Undo edit", "undo", { context: { env: { path: "env" }, key: { path: "key" } } }),
    { id: "pending-diff", component: "List", children: { componentId: "diff", path: "/pending/diff" } },
    { id: "diff", component: "Collapsible", title: "Diff", child: "diff-code" },
    { id: "diff-code", component: "Code", language: "diff", text: { path: "text" } },

    { id: "create", component: "Collapsible", title: "New flag", child: "create-body" },
    createBody(false),
    { id: "create-fields", component: "Grid", columns: 2, children: ["draft-key", "draft-owner"] },
    { id: "draft-key", component: "TextField", label: "Flag key", validationRegexp: FLAG_KEY_PATTERN, value: { path: "/draft/key" } },
    {
      id: "draft-owner",
      component: "ChoicePicker",
      label: "Owning team",
      variant: "mutuallyExclusive",
      displayStyle: "dropdown",
      options: TEAMS.map((team) => ({ label: team.label, value: team.id })),
      value: { path: "/draft/owner" },
    },
    { id: "draft-description", component: "TextField", label: "What it gates", variant: "longText", value: { path: "/draft/description" } },
    text("draft-hint", "Keys look like checkout-v2: lowercase letters, digits and single hyphens. New flags start off in every environment.", "caption"),
    { id: "create-error", component: "Callout", tone: "danger", title: "Flag not created", text: { path: "/createError" } },
    { id: "create-footer", component: "Footer", end: ["create-submit"] },
    ...button("create-submit", "Create flag", "create", { icon: "add", context: { draft: { path: "/draft" } } }),

    { id: "audit", component: "Collapsible", title: "Audit log", child: "audit-body" },
    { id: "audit-body", component: "Column", children: ["audit-empty", "audit-table"] },
    { id: "audit-empty", component: "List", children: { componentId: "empty-state", path: "/auditEmpty" } },
    {
      id: "audit-table",
      component: "Table",
      columns: [
        { key: "time", title: "When" },
        { key: "env", title: "Environment" },
        { key: "flag", title: "Flag" },
        { key: "change", title: "Change" },
        { key: "actor", title: "By" },
      ],
      rows: { path: "/audit" },
    },
  ]
}

export type ViewContext = { readonly query: string; readonly formatTime: (iso: string) => string }

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

function promotionNotice(warnings: readonly string[]): Json[] {
  const title = warnings.length === 1 ? "Production before Staging" : `${warnings.length} flags reach Production before Staging`
  return when(warnings.length > 0, { title, text: warnings.join(" ") })
}

export function displayEntries(store: FlagStore, context: ViewContext): Map<string, Json> {
  const visible = searchFlags(store.flags, context.query)
  const changes = pendingChanges(store)
  const entries = new Map<string, Json>()
  entries.set("/header", {
    subtitle: `${store.flags.length} flags across ${ENVIRONMENTS.length} environments`,
    pending: changes.length === 0 ? { label: "In sync", tone: "success" } : { label: `${changes.length} pending`, tone: "warning" },
  })
  entries.set("/search/summary", context.query.trim() === "" ? `Showing all ${store.flags.length} flags` : `Showing ${visible.length} of ${store.flags.length} flags for “${context.query.trim()}”`)
  for (const env of ENVIRONMENTS) {
    const summary = envSummary(store, env.id)
    entries.set(`/kpis/${env.id}`, { value: `${summary.on} of ${summary.total} on`, caption: summary.pending === 0 ? "In sync" : `${plural(summary.pending, "change")} staged` })
    entries.set(
      `/envs/${env.id}/rows`,
      visible.map((flag) => {
        const setting = effectiveSetting(store, env.id, flag)
        const applied = flag.envs[env.id]
        const staged = store.staged[env.id][flag.key] !== undefined
        const state = stateBadge(setting)
        return {
          env: env.id,
          key: flag.key,
          owner: teamLabel(flag.owner),
          description: flag.description,
          state: state.label,
          stateTone: state.tone,
          tuning: `Audience · ${audienceLabel(setting)}`,
          applied: `Applied: ${audienceLabel(applied)} · changed ${context.formatTime(applied.changedAt)} by ${applied.changedBy}`,
          enabled: setting.enabled,
          rollout: setting.rollout,
          segments: [...setting.segments],
          pending: when(staged, { text: "Pending" }),
          undo: when(staged, { env: env.id, key: flag.key }),
        }
      }),
    )
    entries.set(`/envs/${env.id}/empty`, when(visible.length === 0, { title: "No flags match", description: `Nothing in ${env.title} matches “${context.query.trim()}”. Clear the search to see every flag.` }))
  }
  const diff = pendingDiff(changes)
  entries.set("/pending", {
    title: changes.length === 0 ? "No pending changes" : `Pending changes (${changes.length})`,
    summary: changeSummary(changes),
    empty: when(changes.length === 0, { title: "Everything is applied", description: "Staged edits appear here with a diff before they reach any environment." }),
    warnings: promotionNotice(promotionWarnings(store, changes)),
    changes: changes.map((change) => ({ env: change.env, key: change.key, description: describeChange(change), envTitle: envTitle(change.env), envTone: envTone(change.env) })),
    diff: when(diff !== "", { text: diff }),
  })
  entries.set(
    "/audit",
    store.audit.map((entry) => ({ time: context.formatTime(entry.at), env: envTitle(entry.env), flag: entry.key, change: entry.change, actor: entry.actor })),
  )
  entries.set("/auditEmpty", when(store.audit.length === 0, { title: "No changes yet", description: "Applied changes are recorded here." }))
  const prodOn = envSummary(store, "prod").on
  entries.set("/kill", prodOn === 0 ? "Every production flag is off." : `${prodOn} production flag${prodOn === 1 ? " is" : "s are"} on right now.`)
  return entries
}

export function emptyDraft(): Record<string, Json> {
  return { key: "", description: "", owner: [] }
}

function isObject(value: Json | undefined): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function withValue(node: Json | undefined, segments: readonly string[], value: Json): Json {
  const [head, ...rest] = segments
  if (head === undefined) return value
  if (Array.isArray(node) || (node === undefined && /^\d+$/.test(head))) {
    const list = Array.isArray(node) ? [...node] : []
    list[Number(head)] = withValue(list[Number(head)], rest, value)
    return list
  }
  const object = isObject(node) ? { ...node } : {}
  object[head] = withValue(object[head], rest, value)
  return object
}

function pointerSegments(pointer: string): string[] {
  return pointer.slice(1).split("/")
}

export function initialData(entries: Map<string, Json>, query: string): { [key: string]: Json } {
  let data: Json = { search: { query }, draft: emptyDraft(), createError: "" }
  for (const [pointer, value] of entries) data = withValue(data, pointerSegments(pointer), value)
  return isObject(data) ? data : {}
}

export function update(surfaceId: string, path: string, value: Json): SurfaceMessage {
  return { version: VERSION, updateDataModel: { surfaceId, path, value } }
}

export function replaceComponents(surfaceId: string, components: SurfaceComponent[]): SurfaceMessage {
  return { version: VERSION, updateComponents: { surfaceId, components } }
}

export function openingMessages(surfaceId: string, data: Record<string, Json>): SurfaceMessage[] {
  return [
    { version: VERSION, createSurface: { surfaceId, catalogId: SURFACE_CATALOG_ID } },
    replaceComponents(surfaceId, flagComponents()),
    update(surfaceId, "/", data),
  ]
}

export function changedEntries(surfaceId: string, shown: Map<string, Json>, next: Map<string, Json>): SurfaceMessage[] {
  const messages: SurfaceMessage[] = []
  for (const [pointer, value] of next) {
    const before = shown.get(pointer)
    if (JSON.stringify(before) === JSON.stringify(value)) continue
    if (isObject(before) && isObject(value)) {
      for (const [key, field] of Object.entries(value)) {
        if (JSON.stringify(before[key]) !== JSON.stringify(field)) messages.push(update(surfaceId, `${pointer}/${key}`, field))
      }
    } else messages.push(update(surfaceId, pointer, value))
  }
  return messages
}
