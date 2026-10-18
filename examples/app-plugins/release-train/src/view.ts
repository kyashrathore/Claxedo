import type { SurfaceComponent, SurfaceMessage } from "@claxedo/plugin-api"
import {
  BUMPS,
  bumpVersion,
  CHANGE_TYPES,
  changelogMarkdown,
  conventionalCommits,
  groupProgress,
  openBlockers,
  overallProgress,
  STAGE_IDS,
  STAGE_TITLES,
  stageProgress,
  suggestedBump,
  targetVersion,
  type ChangeType,
  type Progress,
  type Release,
  type StageId,
} from "./model"

export const CATALOG_ID = "https://claxedo.dev/a2ui/v0.9/catalog.json"
const VERSION = "v0.9"

type Binding = { path: string }
type Context = Record<string, Binding | string>
type DataValue = Extract<SurfaceMessage, { updateDataModel: unknown }>["updateDataModel"]["value"]
type ButtonOptions = { variant?: "primary" | "default" | "borderless"; icon?: Extract<SurfaceComponent, { component: "Button" }>["icon"] }

export type NoticeKey = "ship" | "entry" | "owner"
export type Notice = { title: string; text: string; action?: string }

function text(id: string, value: string | Binding, variant?: "caption" | "body"): SurfaceComponent {
  return variant ? { id, component: "Text", text: value, variant } : { id, component: "Text", text: value }
}

function button(id: string, label: string, name: string, context?: Context, options: ButtonOptions = {}): SurfaceComponent[] {
  return [{ id, component: "Button", child: `${id}-label`, action: { event: context ? { name, context } : { name } }, ...options }, text(`${id}-label`, label)]
}

function stat(id: string, label: string, key: string): SurfaceComponent {
  return { id, component: "Stat", label, value: { path: `/release/${key}/value` }, caption: { path: `/release/${key}/caption` } }
}

const CHECKS_CONTEXT: Context = { stages: { path: "/stages" }, bump: { path: "/bump" }, date: { path: "/releaseDate" } }

function noticeCallout(key: NoticeKey, action: string | undefined): SurfaceComponent {
  return {
    id: `${key}-notice`,
    component: "Callout",
    tone: "danger",
    title: { path: `/notices/${key}/title` },
    text: { path: `/notices/${key}/text` },
    ...(action ? { action } : {}),
  }
}

export function rootComponent(shipNotice: boolean): SurfaceComponent {
  return { id: "root", component: "Column", children: ["header", ...(shipNotice ? ["ship-notice"] : []), "kpis", "plan", "checklist", "changelog", "owners"] }
}

export function entryFormBody(notice: boolean): SurfaceComponent {
  return { id: "entry-form-body", component: "Column", children: ["entry-fields", "entry-description", ...(notice ? ["entry-notice"] : []), "entry-footer"] }
}

export function ownerFormBody(notice: boolean): SurfaceComponent {
  return { id: "owner-form-body", component: "Column", children: ["owner-fields", ...(notice ? ["owner-notice"] : []), "owner-footer"] }
}

const NOTICE_HOSTS: Record<NoticeKey, (shown: boolean) => SurfaceComponent> = { ship: rootComponent, entry: entryFormBody, owner: ownerFormBody }

export function noticeMessages(surfaceId: string, key: NoticeKey, notice: Notice | null, wasShown: boolean): SurfaceMessage[] {
  if (!notice) return wasShown ? [components(surfaceId, [NOTICE_HOSTS[key](false)])] : []
  const { action, ...words } = notice
  return [patch(surfaceId, `/notices/${key}`, words), components(surfaceId, [...(wasShown ? [] : [NOTICE_HOSTS[key](true)]), noticeCallout(key, action)])]
}

export function announceStatus(busy: boolean): SurfaceComponent {
  return busy
    ? { id: "announce-status", component: "Spinner", label: "Starting the announcement session…" }
    : text("announce-status", { path: "/announce/status" }, "caption")
}

function stageComponents(stageId: StageId, index: number): SurfaceComponent[] {
  const children = [`stage-${stageId}-progress`, `stage-${stageId}-groups`, ...(stageId === "announce" ? ["announce-section"] : [])]
  return [
    { id: `stage-${stageId}`, component: "Column", children },
    { id: `stage-${stageId}-progress`, component: "Progress", value: { path: `/progress/${stageId}/percent` }, max: 100, label: { path: `/progress/${stageId}/label` } },
    { id: `stage-${stageId}-groups`, component: "List", children: { componentId: "group", path: `/stages/${index}/groups` } },
  ]
}

export function entriesBody(hasEntries: boolean): SurfaceComponent {
  return hasEntries
    ? { id: "entries-body", component: "List", children: { componentId: "entry-row", path: "/changelog/entries" } }
    : { id: "entries-body", component: "EmptyState", title: "No changelog entries yet", description: "Add a feature, fix or chore below to build the release notes." }
}

function pickerOptions<Value extends string>(values: readonly Value[], label: (value: Value) => string = (value) => value) {
  return values.map((value) => ({ label: label(value), value }))
}

export function releaseComponents(release: Release): SurfaceComponent[] {
  return [
    rootComponent(false),
    { id: "header", component: "Header", title: "Release train", subtitle: { path: "/release/subtitle" }, icon: "upload", badges: ["header-version", "header-status"], actions: ["next-release", "ship-release"] },
    { id: "header-version", component: "Badge", text: { path: "/release/current" } },
    { id: "header-status", component: "Badge", text: { path: "/release/status" }, variant: { path: "/release/tone" } },
    ...button("next-release", "Start next release", "startNext", undefined, { variant: "borderless", icon: "refresh" }),
    ...button("ship-release", "Ship release", "ship", CHECKS_CONTEXT, { variant: "primary", icon: "upload" }),
    ...button("ship-retry", "Retry ship", "ship", CHECKS_CONTEXT, { icon: "refresh" }),
    ...button("ship-start-next", "Start next release", "startNext", undefined, { icon: "refresh" }),

    { id: "kpis", component: "Grid", columns: 4, children: ["kpi-next", "kpi-checks", "kpi-blockers", "kpi-changelog"] },
    stat("kpi-next", "Next version", "next"),
    stat("kpi-checks", "Checks done", "checks"),
    stat("kpi-blockers", "Blocking items", "blockers"),
    stat("kpi-changelog", "Changelog", "entries"),

    {
      id: "plan",
      component: "Section",
      title: "Version and date",
      description: "Pick the bump and the release date, then apply them to the plan.",
      child: "plan-body",
    },
    { id: "plan-body", component: "Column", children: ["plan-fields", "plan-footer"] },
    { id: "plan-fields", component: "Grid", columns: 2, children: ["bump", "release-date"] },
    { id: "plan-footer", component: "Footer", end: ["apply-bump"] },
    ...button("apply-bump", "Apply bump", "applyBump", { bump: { path: "/bump" }, date: { path: "/releaseDate" } }, { icon: "check" }),
    { id: "bump", component: "ChoicePicker", label: "Version bump", variant: "mutuallyExclusive", displayStyle: "chips", options: pickerOptions(BUMPS), value: { path: "/bump" } },
    { id: "release-date", component: "DateTimeInput", label: "Release date", enableDate: true, enableTime: true, value: { path: "/releaseDate" } },

    { id: "checklist", component: "Section", title: "Checklist", description: { path: "/progress/overall/label" }, child: "checklist-body" },
    { id: "checklist-body", component: "Column", children: ["stages", "checklist-footer"] },
    { id: "checklist-footer", component: "Footer", end: ["save-progress"] },
    ...button("save-progress", "Save progress", "saveProgress", CHECKS_CONTEXT, { icon: "check" }),
    { id: "stages", component: "Tabs", tabs: STAGE_IDS.map((stageId) => ({ title: STAGE_TITLES[stageId], child: `stage-${stageId}` })) },
    ...STAGE_IDS.flatMap((stageId, index) => stageComponents(stageId, index)),
    { id: "group", component: "Section", variant: "plain", title: { path: "title" }, description: { path: "progress" }, child: "group-items" },
    { id: "group-items", component: "Column", children: { componentId: "check-row", path: "items" } },
    { id: "check-row", component: "Row", align: "center", children: ["check-item", "check-kind"] },
    { id: "check-item", component: "CheckBox", label: { path: "label" }, value: { path: "done" }, weight: 1 },
    { id: "check-kind", component: "Badge", text: { path: "kind" }, variant: { path: "tone" } },
    { id: "announce-section", component: "Section", variant: "plain", title: "Announcement", actions: ["announce"], child: "announce-status" },
    ...button("announce", "Draft announcement", "draftAnnouncement", CHECKS_CONTEXT, { icon: "send" }),
    announceStatus(false),

    { id: "changelog", component: "Section", title: "Changelog", description: { path: "/changelog/caption" }, child: "changelog-body" },
    { id: "changelog-body", component: "Column", children: ["entries-body", "entry-form", "changelog-preview"] },
    entriesBody(release.changelog.length > 0),
    { id: "entry-row", component: "ListItem", title: { path: "description" }, subtitle: { path: "scope" }, icon: { path: "icon" }, meta: ["entry-type-badge"], actions: ["entry-remove"] },
    { id: "entry-type-badge", component: "Badge", text: { path: "kind" }, variant: { path: "tone" } },
    ...button("entry-remove", "Remove entry", "removeEntry", { id: { path: "id" } }, { icon: "delete" }),
    { id: "entry-form", component: "Section", variant: "plain", title: "Add an entry", child: "entry-form-body" },
    entryFormBody(false),
    { id: "entry-fields", component: "Grid", columns: 2, children: ["entry-type", "entry-scope"] },
    { id: "entry-type", component: "ChoicePicker", label: "Type", variant: "mutuallyExclusive", displayStyle: "chips", options: pickerOptions(CHANGE_TYPES), value: { path: "/entryDraft/type" } },
    { id: "entry-scope", component: "TextField", label: "Scope", value: { path: "/entryDraft/scope" } },
    { id: "entry-description", component: "TextField", label: "Description", value: { path: "/entryDraft/description" } },
    { id: "entry-footer", component: "Footer", end: ["add-entry"] },
    ...button("add-entry", "Add entry", "addEntry", { type: { path: "/entryDraft/type" }, scope: { path: "/entryDraft/scope" }, description: { path: "/entryDraft/description" } }, { icon: "add" }),
    { id: "changelog-preview", component: "Collapsible", title: "Release notes preview", child: "changelog-views" },
    {
      id: "changelog-views",
      component: "Tabs",
      tabs: [
        { title: "Rendered", child: "changelog-markdown" },
        { title: "Markdown source", child: "changelog-source" },
        { title: "Commits", child: "changelog-commits" },
      ],
    },
    { id: "changelog-markdown", component: "Markdown", text: { path: "/changelog/markdown" } },
    { id: "changelog-source", component: "Code", language: "markdown", text: { path: "/changelog/markdown" } },
    { id: "changelog-commits", component: "Code", language: "text", text: { path: "/changelog/commits" } },

    { id: "owners", component: "Section", title: "Owners", description: "Who signs off each stage", child: "owners-body" },
    { id: "owners-body", component: "Column", children: ["owners-list", "owner-form"] },
    { id: "owners-list", component: "List", children: { componentId: "owner-row", path: "/owners" } },
    { id: "owner-row", component: "ListItem", title: { path: "name" }, subtitle: { path: "role" }, icon: "person", meta: ["owner-stage-badge"] },
    { id: "owner-stage-badge", component: "Badge", text: { path: "stage" } },
    { id: "owner-form", component: "Section", variant: "plain", title: "Add an owner", child: "owner-form-body" },
    ownerFormBody(false),
    { id: "owner-fields", component: "Grid", columns: 3, children: ["owner-name", "owner-role", "owner-stage"] },
    { id: "owner-name", component: "TextField", label: "Owner name", value: { path: "/ownerDraft/name" } },
    { id: "owner-role", component: "TextField", label: "Role", value: { path: "/ownerDraft/role" } },
    {
      id: "owner-stage",
      component: "ChoicePicker",
      label: "Stage",
      variant: "mutuallyExclusive",
      displayStyle: "dropdown",
      options: pickerOptions(STAGE_IDS, (stageId) => STAGE_TITLES[stageId]),
      value: { path: "/ownerDraft/stage" },
    },
    { id: "owner-footer", component: "Footer", end: ["add-owner"] },
    ...button("add-owner", "Add owner", "addOwner", { name: { path: "/ownerDraft/name" }, role: { path: "/ownerDraft/role" }, stage: { path: "/ownerDraft/stage" } }, { icon: "add" }),
  ]
}

function progressData(progress: Progress, noun: string) {
  return { percent: progress.percent, label: `${progress.done} of ${progress.total} ${noun} done` }
}

function entryCount(count: number): string {
  return count === 0 ? "No entries" : count === 1 ? "1 entry" : `${count} entries`
}

function displayDate(date: string): string {
  return date ? date.replace("T", " ") : "unscheduled"
}

export function releaseData(release: Release) {
  const blockers = openBlockers(release)
  const overall = overallProgress(release.stages)
  const target = targetVersion(release)
  const blockerStages = STAGE_IDS.map((stageId) => [STAGE_TITLES[stageId], blockers.filter((blocker) => blocker.stage === STAGE_TITLES[stageId]).length] as const).filter(([, count]) => count > 0)
  return {
    current: `v${release.currentVersion}`,
    status: release.shipped ? "Shipped" : blockers.length === 0 ? "Ready to ship" : `${blockers.length} blocking open`,
    tone: release.shipped ? "success" : blockers.length === 0 ? "accent" : "warning",
    subtitle: release.shipped
      ? `v${release.shipped.version} shipped · release date ${displayDate(release.shipped.releaseDate)}`
      : `v${release.currentVersion} → v${target} · ${release.bump} bump · ships ${displayDate(release.releaseDate)}`,
    next: {
      value: `v${target}`,
      caption: release.shipped ? "Shipped" : BUMPS.map((bump) => `${bump} ${bumpVersion(release.currentVersion, bump)}`).join(" · "),
    },
    checks: { value: `${overall.done} of ${overall.total}`, caption: `${overall.percent}% complete` },
    blockers: {
      value: blockers.length === 0 ? "None open" : `${blockers.length} open`,
      caption: blockerStages.length === 0 ? "Nothing gates the ship" : blockerStages.map(([stage, count]) => `${stage} ${count}`).join(" · "),
    },
    entries: { value: entryCount(release.changelog.length), caption: `Suggests a ${suggestedBump(release.changelog)} bump` },
  }
}

export function stagesData(release: Release) {
  return release.stages.map((stage) => ({
    id: stage.id,
    title: stage.title,
    groups: stage.groups.map((group) => {
      const progress = groupProgress(group)
      return {
        id: group.id,
        title: group.title,
        progress: `${progress.done} of ${progress.total} done`,
        items: group.items.map((item) => ({
          id: item.id,
          label: item.label,
          done: item.done,
          kind: item.blocking ? (item.done ? "Cleared" : "Blocking") : "Optional",
          tone: item.blocking ? (item.done ? "success" : "warning") : "neutral",
        })),
      }
    }),
  }))
}

export function progressesData(release: Release) {
  return {
    overall: progressData(overallProgress(release.stages), "release checks"),
    ...Object.fromEntries(release.stages.map((stage) => [stage.id, progressData(stageProgress(stage), `${stage.title} checks`)])),
  }
}

const ENTRY_LOOK: Record<ChangeType, { kind: string; tone: string; icon: string }> = {
  feat: { kind: "Feature", tone: "accent", icon: "star" },
  fix: { kind: "Fix", tone: "success", icon: "check" },
  chore: { kind: "Chore", tone: "neutral", icon: "settings" },
}

export function changelogData(release: Release) {
  return {
    caption: `${entryCount(release.changelog.length)} for v${targetVersion(release)}`,
    entries: release.changelog.map((entry) => ({
      id: entry.id,
      description: entry.description,
      scope: entry.scope ? `Scope: ${entry.scope}` : "No scope",
      ...ENTRY_LOOK[entry.type],
    })),
    markdown: changelogMarkdown(release),
    commits: conventionalCommits(release.changelog) || "# no entries yet",
  }
}

export function ownersData(release: Release) {
  return release.owners.map((owner) => ({ id: owner.id, name: owner.name, role: owner.role, stage: STAGE_TITLES[owner.stage] }))
}

const EMPTY_NOTICE: Notice = { title: "", text: "" }

export function releaseModel(release: Release) {
  return {
    release: releaseData(release),
    bump: [release.bump],
    releaseDate: release.releaseDate,
    stages: stagesData(release),
    progress: progressesData(release),
    entryDraft: { type: ["feat"], scope: "", description: "" },
    changelog: changelogData(release),
    owners: ownersData(release),
    ownerDraft: { name: "", role: "", stage: ["prepare"] },
    announce: { status: "No announcement session yet. Drafting one opens an agent session with the changelog and owners." },
    notices: { ship: EMPTY_NOTICE, entry: EMPTY_NOTICE, owner: EMPTY_NOTICE },
  }
}

export function patch(surfaceId: string, path: string, value: DataValue): SurfaceMessage {
  return { version: VERSION, updateDataModel: { surfaceId, path, value } }
}

export function components(surfaceId: string, list: SurfaceComponent[]): SurfaceMessage {
  return { version: VERSION, updateComponents: { surfaceId, components: list } }
}

export function openMessages(surfaceId: string, release: Release): SurfaceMessage[] {
  return [
    { version: VERSION, createSurface: { surfaceId, catalogId: CATALOG_ID } },
    components(surfaceId, releaseComponents(release)),
    patch(surfaceId, "/", releaseModel(release)),
  ]
}

export function summaryMessages(surfaceId: string, release: Release): SurfaceMessage[] {
  return [patch(surfaceId, "/release", releaseData(release)), patch(surfaceId, "/progress", progressesData(release))]
}

export function checklistMessages(surfaceId: string, release: Release): SurfaceMessage[] {
  return [...summaryMessages(surfaceId, release), patch(surfaceId, "/stages", stagesData(release))]
}
