import type { SurfaceComponent, SurfaceMessage } from "@claxedo/plugin-api"
import {
  ENVIRONMENTS,
  FLAG_KEY_PATTERN,
  ROLLOUT_STEP,
  SEGMENTS,
  TEAMS,
  audienceLabel,
  changeStat,
  effectiveSetting,
  envSummary,
  envTitle,
  pendingChanges,
  pendingMarkdown,
  searchFlags,
  teamLabel,
  type EnvId,
  type FlagStore,
} from "./model"

export const SURFACE_CATALOG_ID = "https://claxedo.dev/a2ui/v0.9/catalog.json"
const VERSION = "v0.9" as const

type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

function when<Item extends Json>(condition: boolean, item: Item): Item[] {
  return condition ? [item] : []
}

function text(id: string, value: string, variant?: "h1" | "h2" | "h3" | "h4" | "h5" | "caption" | "body"): SurfaceComponent {
  return variant ? { id, component: "Text", text: value, variant } : { id, component: "Text", text: value }
}

export const EDIT_CONTEXT = Object.fromEntries(ENVIRONMENTS.map((env) => [env.id, { path: `/envs/${env.id}/rows` }]))

function button(id: string, label: string, name: string, variant: "default" | "primary" | "borderless" = "default", context: Record<string, { path: string } | string> = {}): SurfaceComponent[] {
  return [
    { id, component: "Button", variant, child: `${id}-label`, action: { event: { name, context: { ...EDIT_CONTEXT, ...context } } } },
    text(`${id}-label`, label),
  ]
}

function envTab(env: EnvId): SurfaceComponent[] {
  const extra = env === "prod" ? [`env-${env}-kill`] : []
  return [
    { id: `env-${env}`, component: "Column", children: [`env-${env}-stats`, `env-${env}-head`, `env-${env}-divider`, `env-${env}-list`, `env-${env}-empty`, ...extra] },
    { id: `env-${env}-stats`, component: "Row", align: "center", children: [`env-${env}-stats-text`, `env-${env}-pending`] },
    { id: `env-${env}-stats-text`, component: "Text", variant: "caption", weight: 1, text: { path: `/envs/${env}/stats` } },
    { id: `env-${env}-pending`, component: "List", direction: "horizontal", children: { componentId: "pending-badge", path: `/envs/${env}/pendingBadge` } },
    { id: `env-${env}-head`, component: "Row", children: [`env-${env}-head-flag`, `env-${env}-head-on`, `env-${env}-head-rollout`, `env-${env}-head-targeting`, `env-${env}-head-actions`] },
    { ...text(`env-${env}-head-flag`, "Flag", "caption"), weight: 3 },
    { ...text(`env-${env}-head-on`, "State", "caption"), weight: 1 },
    { ...text(`env-${env}-head-rollout`, "Rollout", "caption"), weight: 2 },
    { ...text(`env-${env}-head-targeting`, "Targeting", "caption"), weight: 3 },
    { ...text(`env-${env}-head-actions`, "", "caption"), weight: 1 },
    { id: `env-${env}-divider`, component: "Divider" },
    { id: `env-${env}-list`, component: "List", children: { componentId: "flag-row", path: `/envs/${env}/rows` } },
    { id: `env-${env}-empty`, component: "List", children: { componentId: "empty-state", path: `/envs/${env}/empty` } },
  ]
}

export function flagComponents(): SurfaceComponent[] {
  return [
    { id: "root", component: "Column", children: ["header", "search-row", "tabs", "pending-card", "create", "audit"] },

    { id: "header", component: "Row", align: "center", children: ["header-icon", "header-titles", "header-pending"] },
    { id: "header-icon", component: "Icon", name: "settings" },
    { id: "header-titles", component: "Column", weight: 1, children: ["header-title", "header-subtitle"] },
    text("header-title", "Feature flags", "h1"),
    { id: "header-subtitle", component: "Text", variant: "caption", text: { path: "/header/subtitle" } },
    { id: "header-pending", component: "Badge", variant: "accent", text: { path: "/header/pending" } },

    { id: "search-row", component: "Row", align: "end", children: ["search-field", "search", "search-clear", "search-summary"] },
    { id: "search-field", component: "TextField", weight: 1, label: "Search flags", value: { path: "/search/query" } },
    ...button("search", "Search", "search", "default", { query: { path: "/search/query" } }),
    ...button("search-clear", "Clear search", "clearSearch", "borderless"),
    { id: "search-summary", component: "Text", variant: "caption", text: { path: "/search/summary" } },

    { id: "tabs", component: "Tabs", tabs: ENVIRONMENTS.map((env) => ({ title: env.title, child: `env-${env.id}` })) },
    ...ENVIRONMENTS.flatMap((env) => envTab(env.id)),
    { id: "pending-badge", component: "Badge", variant: "accent", text: { path: "text" } },
    { id: "empty-state", component: "EmptyState", title: { path: "title" }, description: { path: "description" } },

    { id: "flag-row", component: "Column", children: ["flag-main", "flag-divider"] },
    { id: "flag-main", component: "Row", align: "center", children: ["flag-info", "flag-state", "flag-rollout", "flag-segments", "flag-actions"] },
    { id: "flag-info", component: "Column", weight: 3, children: ["flag-title", "flag-description", "flag-meta"] },
    { id: "flag-title", component: "Row", align: "center", children: ["flag-key", "flag-owner", "flag-pending"] },
    { id: "flag-key", component: "Text", variant: "h5", text: { path: "key" } },
    { id: "flag-owner", component: "Badge", text: { path: "owner" } },
    { id: "flag-pending", component: "List", direction: "horizontal", children: { componentId: "pending-badge", path: "pending" } },
    { id: "flag-description", component: "Text", variant: "body", text: { path: "description" } },
    { id: "flag-meta", component: "Text", variant: "caption", text: { path: "meta" } },
    { id: "flag-state", component: "Column", weight: 1, children: ["flag-enabled", "flag-audience"] },
    { id: "flag-enabled", component: "Switch", label: "Enabled", value: { path: "enabled" } },
    { id: "flag-audience", component: "Text", variant: "caption", text: { path: "audience" } },
    { id: "flag-rollout", component: "Slider", weight: 2, label: "Rollout %", min: 0, max: 100, step: ROLLOUT_STEP, value: { path: "rollout" } },
    {
      id: "flag-segments",
      component: "ChoicePicker",
      weight: 3,
      label: "Targeting",
      variant: "multipleSelection",
      displayStyle: "chips",
      options: SEGMENTS.map((segment) => ({ label: segment.label, value: segment.id })),
      value: { path: "segments" },
    },
    { id: "flag-actions", component: "List", weight: 1, children: { componentId: "flag-undo", path: "undo" } },
    ...button("flag-undo", "Undo edit", "undo", "borderless", { env: { path: "env" }, key: { path: "key" } }),
    { id: "flag-divider", component: "Divider" },

    { id: "env-prod-kill", component: "Card", child: "kill-body" },
    { id: "kill-body", component: "Column", children: ["kill-title", "kill-help", "kill-summary", "kill-button"] },
    { id: "kill-title", component: "Row", align: "center", children: ["kill-icon", "kill-heading"] },
    { id: "kill-icon", component: "Icon", name: "warning" },
    text("kill-heading", "Production kill switch", "h4"),
    text("kill-help", "Turns every production flag off at once, skipping review. Staged production edits are discarded; rollout and targeting are kept for re-enabling.", "caption"),
    { id: "kill-summary", component: "Text", text: { path: "/kill" } },
    ...button("kill-button", "Disable all production flags", "killProd", "primary"),

    { id: "pending-card", component: "Card", child: "pending-body" },
    { id: "pending-body", component: "Column", children: ["pending-head", "pending-empty", "pending-markdown", "pending-actions"] },
    { id: "pending-head", component: "Row", align: "center", children: ["pending-icon", "pending-title", "pending-diff"] },
    { id: "pending-icon", component: "Icon", name: "notifications" },
    { id: "pending-title", component: "Text", variant: "h3", weight: 1, text: { path: "/pending/title" } },
    { id: "pending-diff", component: "DiffStat", additions: { path: "/pending/additions" }, deletions: { path: "/pending/deletions" } },
    { id: "pending-empty", component: "List", children: { componentId: "empty-state", path: "/pending/empty" } },
    { id: "pending-markdown", component: "Markdown", text: { path: "/pending/markdown" } },
    { id: "pending-actions", component: "Row", children: ["stage", "apply", "revert"] },
    ...button("stage", "Stage edits", "stage"),
    ...button("apply", "Review & apply", "apply", "primary"),
    ...button("revert", "Revert pending", "revert", "borderless"),

    { id: "create", component: "Collapsible", title: "New flag", child: "create-body" },
    { id: "create-body", component: "Column", children: ["draft-key", "draft-description", "draft-owner", "draft-hint", "create-submit"] },
    { id: "draft-key", component: "TextField", label: "Flag key", validationRegexp: FLAG_KEY_PATTERN, value: { path: "/draft/key" } },
    { id: "draft-description", component: "TextField", label: "What it gates", variant: "longText", value: { path: "/draft/description" } },
    {
      id: "draft-owner",
      component: "ChoicePicker",
      label: "Owning team",
      variant: "mutuallyExclusive",
      displayStyle: "dropdown",
      options: TEAMS.map((team) => ({ label: team.label, value: team.id })),
      value: { path: "/draft/owner" },
    },
    text("draft-hint", "Keys look like checkout-v2: lowercase letters, digits and single hyphens. New flags start off in every environment.", "caption"),
    ...button("create-submit", "Create flag", "create", "primary", { draft: { path: "/draft" } }),

    { id: "audit", component: "Collapsible", title: "Audit log", open: true, child: "audit-body" },
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

export function displayEntries(store: FlagStore, context: ViewContext): Map<string, Json> {
  const visible = searchFlags(store.flags, context.query)
  const changes = pendingChanges(store)
  const stat = changeStat(changes)
  const entries = new Map<string, Json>()
  entries.set("/header", {
    subtitle: `${store.flags.length} flags across ${ENVIRONMENTS.length} environments · ${ENVIRONMENTS.map((env) => `${env.title} ${envSummary(store, env.id).on} on`).join(" · ")}`,
    pending: changes.length === 0 ? "In sync" : `${changes.length} pending`,
  })
  entries.set("/search/summary", context.query.trim() === "" ? `Showing all ${store.flags.length} flags` : `Showing ${visible.length} of ${store.flags.length} flags for “${context.query.trim()}”`)
  for (const env of ENVIRONMENTS) {
    const summary = envSummary(store, env.id)
    entries.set(
      `/envs/${env.id}/rows`,
      visible.map((flag) => {
        const setting = effectiveSetting(store, env.id, flag)
        const applied = flag.envs[env.id]
        const staged = store.staged[env.id][flag.key] !== undefined
        return {
          env: env.id,
          key: flag.key,
          owner: teamLabel(flag.owner),
          description: flag.description,
          meta: `Applied: ${audienceLabel(applied)} · changed ${context.formatTime(applied.changedAt)} by ${applied.changedBy}`,
          enabled: setting.enabled,
          rollout: setting.rollout,
          segments: [...setting.segments],
          audience: audienceLabel(setting),
          pending: when(staged, { text: "Pending" }),
          undo: when(staged, { env: env.id, key: flag.key }),
        }
      }),
    )
    entries.set(`/envs/${env.id}/empty`, when(visible.length === 0, { title: "No flags match", description: `Nothing in ${env.title} matches “${context.query.trim()}”. Clear the search to see every flag.` }))
    entries.set(`/envs/${env.id}/stats`, `${summary.on} of ${summary.total} flags on in ${env.title}`)
    entries.set(`/envs/${env.id}/pendingBadge`, when(summary.pending > 0, { text: `${summary.pending} pending` }))
  }
  entries.set("/pending", {
    title: changes.length === 0 ? "No pending changes" : `Pending changes (${changes.length})`,
    additions: stat.additions,
    deletions: stat.deletions,
    markdown: pendingMarkdown(store, changes),
    empty: when(changes.length === 0, { title: "Everything is applied", description: "Staged edits appear here with a diff before they reach any environment." }),
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
  let data: Json = { search: { query }, draft: emptyDraft() }
  for (const [pointer, value] of entries) data = withValue(data, pointerSegments(pointer), value)
  return isObject(data) ? data : {}
}

export function update(surfaceId: string, path: string, value: Json): SurfaceMessage {
  return { version: VERSION, updateDataModel: { surfaceId, path, value } }
}

export function openingMessages(surfaceId: string, data: Record<string, Json>): SurfaceMessage[] {
  return [
    { version: VERSION, createSurface: { surfaceId, catalogId: SURFACE_CATALOG_ID } },
    { version: VERSION, updateComponents: { surfaceId, components: flagComponents() } },
    { version: VERSION, updateDataModel: { surfaceId, path: "/", value: data } },
  ]
}

export function changedEntries(surfaceId: string, shown: Map<string, Json>, next: Map<string, Json>): SurfaceMessage[] {
  const messages: SurfaceMessage[] = []
  for (const [pointer, value] of next) {
    if (JSON.stringify(shown.get(pointer)) !== JSON.stringify(value)) messages.push(update(surfaceId, pointer, value))
  }
  return messages
}
