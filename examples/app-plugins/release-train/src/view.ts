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
  type Progress,
  type Release,
  type StageId,
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

const CHECKS_CONTEXT: Context = { stages: { path: "/stages" }, bump: { path: "/bump" }, date: { path: "/releaseDate" } }

function stageActions(stageId: StageId): { ids: string[]; components: SurfaceComponent[] } {
  const save = button(`save-${stageId}`, "Save progress", "saveProgress", CHECKS_CONTEXT)
  if (stageId === "ship") {
    return {
      ids: [`save-${stageId}`, "ship-release", "next-release"],
      components: [...save, ...button("ship-release", "Ship release", "ship", CHECKS_CONTEXT, "primary"), ...button("next-release", "Start next release", "startNext", undefined, "borderless")],
    }
  }
  if (stageId === "announce") {
    return {
      ids: [`save-${stageId}`, "announce", "announce-status"],
      components: [
        ...save,
        ...button("announce", "Draft announcement in a new agent session", "draftAnnouncement", CHECKS_CONTEXT, "primary"),
        announceStatus(false),
      ],
    }
  }
  return { ids: [`save-${stageId}`], components: save }
}

export function announceStatus(busy: boolean): SurfaceComponent {
  return busy
    ? { id: "announce-status", component: "Spinner", label: "Starting the announcement session" }
    : { ...text("announce-status", { path: "/announce/status" }, "caption"), weight: 1 }
}

function stageComponents(stageId: StageId, index: number): SurfaceComponent[] {
  const actions = stageActions(stageId)
  return [
    { id: `stage-${stageId}`, component: "Column", children: [`stage-${stageId}-progress`, `stage-${stageId}-groups`, `stage-${stageId}-actions`] },
    { id: `stage-${stageId}-progress`, component: "Progress", value: { path: `/progress/${stageId}/percent` }, max: 100, label: { path: `/progress/${stageId}/label` } },
    { id: `stage-${stageId}-groups`, component: "List", children: { componentId: "group", path: `/stages/${index}/groups` } },
    { id: `stage-${stageId}-actions`, component: "Row", align: "center", children: actions.ids },
    ...actions.components,
  ]
}

export function entriesBody(hasEntries: boolean): SurfaceComponent {
  return hasEntries
    ? { id: "entries-body", component: "List", children: { componentId: "entry-row", path: "/changelog/entries" } }
    : { id: "entries-body", component: "EmptyState", title: "No changelog entries", description: "Add a feat, fix or chore entry to build the changelog." }
}

export function releaseComponents(release: Release): SurfaceComponent[] {
  return [
    { id: "root", component: "Column", children: ["header", "release-card", "stages", "changelog-card", "owners-card"] },
    { id: "header", component: "Row", align: "center", children: ["header-icon", "header-title", "header-version", "header-status"] },
    { id: "header-icon", component: "Icon", name: "send" },
    { ...text("header-title", "Release train", "h2"), weight: 1 },
    { id: "header-version", component: "Badge", text: { path: "/release/current" } },
    { id: "header-status", component: "Badge", text: { path: "/release/status" }, variant: "accent" },

    { id: "release-card", component: "Card", child: "release-column" },
    { id: "release-column", component: "Column", children: ["release-title", "release-candidates", "release-suggestion", "bump-row", "release-date", "overall-progress"] },
    text("release-title", { path: "/release/title" }, "h3"),
    text("release-candidates", { path: "/release/candidates" }, "caption"),
    text("release-suggestion", { path: "/release/suggestion" }, "caption"),
    { id: "bump-row", component: "Row", align: "end", children: ["bump", "apply-bump"] },
    {
      id: "bump",
      component: "ChoicePicker",
      label: "Version bump",
      variant: "mutuallyExclusive",
      displayStyle: "chips",
      options: BUMPS.map((bump) => ({ label: bump, value: bump })),
      value: { path: "/bump" },
    },
    ...button("apply-bump", "Apply bump", "applyBump", { bump: { path: "/bump" } }, "borderless"),
    { id: "release-date", component: "DateTimeInput", label: "Release date", enableDate: true, enableTime: true, value: { path: "/releaseDate" } },
    { id: "overall-progress", component: "Progress", value: { path: "/progress/overall/percent" }, max: 100, label: { path: "/progress/overall/label" } },

    { id: "stages", component: "Tabs", tabs: STAGE_IDS.map((stageId) => ({ title: STAGE_TITLES[stageId], child: `stage-${stageId}` })) },
    ...STAGE_IDS.flatMap((stageId, index) => stageComponents(stageId, index)),
    { id: "group", component: "Collapsible", title: { path: "title" }, child: "group-items", open: true },
    { id: "group-items", component: "Column", children: { componentId: "check-item", path: "items" } },
    { id: "check-item", component: "CheckBox", label: { path: "label" }, value: { path: "done" } },

    { id: "changelog-card", component: "Card", child: "changelog-column" },
    { id: "changelog-column", component: "Column", children: ["changelog-title", "entry-form", "add-entry", "entries-body", "changelog-divider", "changelog-views"] },
    text("changelog-title", "Changelog", "h3"),
    { id: "entry-form", component: "Row", align: "end", children: ["entry-type", "entry-scope", "entry-description"] },
    {
      id: "entry-type",
      component: "ChoicePicker",
      label: "Type",
      variant: "mutuallyExclusive",
      displayStyle: "chips",
      options: CHANGE_TYPES.map((type) => ({ label: type, value: type })),
      value: { path: "/entryDraft/type" },
    },
    { id: "entry-scope", component: "TextField", label: "Scope", value: { path: "/entryDraft/scope" }, weight: 1 },
    { id: "entry-description", component: "TextField", label: "Description", value: { path: "/entryDraft/description" }, weight: 3 },
    ...button("add-entry", "Add entry", "addEntry", { type: { path: "/entryDraft/type" }, scope: { path: "/entryDraft/scope" }, description: { path: "/entryDraft/description" } }, "primary"),
    entriesBody(release.changelog.length > 0),
    { id: "entry-row", component: "Row", align: "center", children: ["entry-type-badge", "entry-line", "entry-remove"] },
    { id: "entry-type-badge", component: "Badge", text: { path: "type" } },
    { ...text("entry-line", { path: "line" }), weight: 1 },
    ...button("entry-remove", "Remove", "removeEntry", { id: { path: "id" } }, "borderless"),
    { id: "changelog-divider", component: "Divider" },
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

    { id: "owners-card", component: "Card", child: "owners-column" },
    { id: "owners-column", component: "Column", children: ["owners-title", "owners-table", "owner-form", "add-owner"] },
    text("owners-title", "Owners", "h3"),
    {
      id: "owners-table",
      component: "Table",
      columns: [
        { key: "name", title: "Owner" },
        { key: "role", title: "Role" },
        { key: "stage", title: "Stage" },
      ],
      rows: { path: "/owners" },
    },
    { id: "owner-form", component: "Row", align: "end", children: ["owner-name", "owner-role", "owner-stage"] },
    { id: "owner-name", component: "TextField", label: "Owner name", value: { path: "/ownerDraft/name" }, weight: 1 },
    { id: "owner-role", component: "TextField", label: "Role", value: { path: "/ownerDraft/role" }, weight: 1 },
    {
      id: "owner-stage",
      component: "ChoicePicker",
      label: "Stage",
      variant: "mutuallyExclusive",
      displayStyle: "dropdown",
      options: STAGE_IDS.map((stageId) => ({ label: STAGE_TITLES[stageId], value: stageId })),
      value: { path: "/ownerDraft/stage" },
    },
    ...button("add-owner", "Add owner", "addOwner", { name: { path: "/ownerDraft/name" }, role: { path: "/ownerDraft/role" }, stage: { path: "/ownerDraft/stage" } }),
  ]
}

function progressData(progress: Progress, noun: string) {
  return { percent: progress.percent, label: `${progress.done} of ${progress.total} ${noun} done` }
}

export function releaseData(release: Release) {
  const blockers = openBlockers(release).length
  const candidates = BUMPS.map((bump) => `${bump} → ${bumpVersion(release.currentVersion, bump)}`).join(" · ")
  return {
    current: `v${release.currentVersion}`,
    status: release.shipped ? "Shipped" : blockers === 0 ? "Ready to ship" : `${blockers} blocking open`,
    title: release.shipped
      ? `v${release.shipped.version} shipped for ${release.shipped.releaseDate.replace("T", " ")}`
      : `v${release.currentVersion} → v${targetVersion(release)} (${release.bump})`,
    candidates: `From v${release.currentVersion}: ${candidates}`,
    suggestion: `The changelog suggests a ${suggestedBump(release.changelog)} bump`,
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
        title: `${group.title} (${progress.done}/${progress.total})`,
        items: group.items.map((item) => ({ id: item.id, label: item.blocking ? `${item.label} (blocking)` : item.label, done: item.done })),
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

export function changelogData(release: Release) {
  return {
    entries: release.changelog.map((entry) => ({ id: entry.id, type: entry.type, line: entry.scope ? `${entry.scope}: ${entry.description}` : entry.description })),
    markdown: changelogMarkdown(release),
    commits: conventionalCommits(release.changelog) || "# no entries yet",
  }
}

export function ownersData(release: Release) {
  return release.owners.map((owner) => ({ name: owner.name, role: owner.role, stage: STAGE_TITLES[owner.stage] }))
}

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
    announce: { status: "No announcement session yet" },
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
