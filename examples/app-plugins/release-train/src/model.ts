export type StageId = "prepare" | "verify" | "ship" | "announce"
export type Bump = "major" | "minor" | "patch"
export type ChangeType = "feat" | "fix" | "chore"

export type CheckItem = { id: string; label: string; blocking: boolean; done: boolean }
export type CheckGroup = { id: string; title: string; items: CheckItem[] }
export type Stage = { id: StageId; title: string; groups: CheckGroup[] }
export type ChangelogEntry = { id: string; type: ChangeType; scope: string; description: string }
export type Owner = { id: string; name: string; role: string; stage: StageId }
export type Shipment = { version: string; releaseDate: string; shippedAt: number }

export type Release = {
  currentVersion: string
  bump: Bump
  releaseDate: string
  stages: Stage[]
  changelog: ChangelogEntry[]
  owners: Owner[]
  shipped: Shipment | null
  nextId: number
}

export type Change = { release: Release; error?: string }
export type Progress = { done: number; total: number; percent: number }
export type Blocker = { stage: string; label: string }

export const STAGE_IDS: readonly StageId[] = ["prepare", "verify", "ship", "announce"]
export const GATED_STAGES: readonly StageId[] = ["prepare", "verify", "ship"]
export const BUMPS: readonly Bump[] = ["major", "minor", "patch"]
export const CHANGE_TYPES: readonly ChangeType[] = ["feat", "fix", "chore"]
export const CHANGE_HEADINGS: Record<ChangeType, string> = { feat: "Features", fix: "Fixes", chore: "Chores" }
export const STAGE_TITLES: Record<StageId, string> = { prepare: "Prepare", verify: "Verify", ship: "Ship", announce: "Announce" }

type ItemSeed = readonly [label: string, blocking: boolean]
type GroupSeed = readonly [title: string, items: readonly ItemSeed[]]

const CHECKLIST: Record<StageId, readonly GroupSeed[]> = {
  prepare: [
    ["Branch and scope", [["Cut the release branch from main", true], ["Freeze merges except release fixes", true], ["Triage open issues tagged for this release", false]]],
    ["Dependencies", [["Update lockfile and audit advisories", true], ["Bump internal packages", false]]],
  ],
  verify: [
    ["Automated checks", [["Full test suite is green", true], ["Typecheck and lint pass", true], ["End-to-end flows pass on web and desktop", true]]],
    ["Manual QA", [["Smoke test the upgrade path", true], ["Check accessibility of new screens", false], ["Review crash reports from the beta channel", false]]],
  ],
  ship: [
    ["Pre-flight", [["Release notes reviewed by the owner", true], ["Rollback plan written down", true]]],
    ["Publish", [["Tag the release commit", false], ["Publish packages and installers", false], ["Promote the build to stable", false]]],
  ],
  announce: [
    ["Channels", [["Post the changelog to the blog", false], ["Send the newsletter", false], ["Update the docs site version", false]]],
  ],
}

function seedStages(): Stage[] {
  return STAGE_IDS.map((stageId) => ({
    id: stageId,
    title: STAGE_TITLES[stageId],
    groups: CHECKLIST[stageId].map(([title, items], groupIndex) => ({
      id: `${stageId}-${groupIndex}`,
      title,
      items: items.map(([label, blocking], itemIndex) => ({ id: `${stageId}-${groupIndex}-${itemIndex}`, label, blocking, done: false })),
    })),
  }))
}

export function createRelease(currentVersion = "1.4.3", releaseDate = ""): Release {
  return {
    currentVersion,
    bump: "minor",
    releaseDate,
    stages: seedStages(),
    changelog: [],
    owners: [
      { id: "owner-1", name: "Priya", role: "Release captain", stage: "prepare" },
      { id: "owner-2", name: "Marco", role: "QA lead", stage: "verify" },
      { id: "owner-3", name: "Ana", role: "Comms", stage: "announce" },
    ],
    shipped: null,
    nextId: 4,
  }
}

export type Version = { major: number; minor: number; patch: number }

export function parseVersion(text: string): Version | null {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(text.trim())
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

export function bumpVersion(text: string, bump: Bump): string {
  const version = parseVersion(text)
  if (!version) throw new Error(`${text} is not a major.minor.patch version`)
  if (bump === "major") return `${version.major + 1}.0.0`
  if (bump === "minor") return `${version.major}.${version.minor + 1}.0`
  return `${version.major}.${version.minor}.${version.patch + 1}`
}

export function nextVersion(release: Release): string {
  return bumpVersion(release.currentVersion, release.bump)
}

export function isBump(value: unknown): value is Bump {
  return typeof value === "string" && (BUMPS as readonly string[]).includes(value)
}

export function isChangeType(value: unknown): value is ChangeType {
  return typeof value === "string" && (CHANGE_TYPES as readonly string[]).includes(value)
}

export function isStageId(value: unknown): value is StageId {
  return typeof value === "string" && (STAGE_IDS as readonly string[]).includes(value)
}

export function suggestedBump(entries: readonly ChangelogEntry[]): Bump {
  if (entries.some((entry) => entry.description.includes("BREAKING"))) return "major"
  return entries.some((entry) => entry.type === "feat") ? "minor" : "patch"
}

function progressOf(items: readonly CheckItem[]): Progress {
  const done = items.filter((item) => item.done).length
  return { done, total: items.length, percent: items.length === 0 ? 0 : Math.round((done / items.length) * 100) }
}

export function stageItems(stage: Stage): CheckItem[] {
  return stage.groups.flatMap((group) => group.items)
}

export function stageProgress(stage: Stage): Progress {
  return progressOf(stageItems(stage))
}

export function groupProgress(group: CheckGroup): Progress {
  return progressOf(group.items)
}

export function overallProgress(stages: readonly Stage[]): Progress {
  return progressOf(stages.flatMap(stageItems))
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function collectDone(value: unknown, into: Map<string, boolean>) {
  if (Array.isArray(value)) return value.forEach((item) => collectDone(item, into))
  if (!isRecord(value)) return
  if (typeof value.id === "string" && typeof value.done === "boolean") into.set(value.id, value.done)
  for (const child of Object.values(value)) if (typeof child === "object") collectDone(child, into)
}

export function absorbChecks(release: Release, view: unknown): Release {
  const done = new Map<string, boolean>()
  collectDone(view, done)
  if (done.size === 0) return release
  return {
    ...release,
    stages: release.stages.map((stage) => ({
      ...stage,
      groups: stage.groups.map((group) => ({ ...group, items: group.items.map((item) => ({ ...item, done: done.get(item.id) ?? item.done })) })),
    })),
  }
}

export function openBlockers(release: Release): Blocker[] {
  return release.stages
    .filter((stage) => GATED_STAGES.includes(stage.id))
    .flatMap((stage) => stageItems(stage).filter((item) => item.blocking && !item.done).map((item) => ({ stage: stage.title, label: item.label })))
}

export function ship(release: Release, now: number): Change & { blockers: Blocker[] } {
  if (release.shipped) return { release, blockers: [], error: `v${release.shipped.version} already shipped. Start the next release first.` }
  const blockers = openBlockers(release)
  if (blockers.length > 0) return { release, blockers, error: `${blockers.length} blocking item${blockers.length === 1 ? " is" : "s are"} still open` }
  if (!release.releaseDate) return { release, blockers, error: "Set a release date first." }
  const version = nextVersion(release)
  return { release: { ...release, currentVersion: version, shipped: { version, releaseDate: release.releaseDate, shippedAt: now } }, blockers }
}

export function startNextRelease(release: Release): Release {
  return { ...createRelease(release.currentVersion, ""), owners: release.owners, nextId: release.nextId }
}

export function addEntry(release: Release, type: unknown, scope: string, description: string): Change {
  if (!isChangeType(type)) return { release, error: "Pick feat, fix or chore." }
  const text = description.trim()
  if (!text) return { release, error: "Describe the change." }
  const cleanScope = scope.trim().toLowerCase()
  if (cleanScope && !/^[a-z0-9][a-z0-9-/]*$/.test(cleanScope)) return { release, error: "A scope is lowercase letters, digits, - and /." }
  const entry: ChangelogEntry = { id: `entry-${release.nextId}`, type, scope: cleanScope, description: text }
  return { release: { ...release, changelog: [...release.changelog, entry], nextId: release.nextId + 1 } }
}

export function removeEntry(release: Release, id: string): Release {
  return { ...release, changelog: release.changelog.filter((entry) => entry.id !== id) }
}

export function addOwner(release: Release, name: string, role: string, stage: unknown): Change {
  if (!name.trim() || !role.trim()) return { release, error: "An owner needs a name and a role." }
  if (!isStageId(stage)) return { release, error: "Pick the stage they own." }
  const owner: Owner = { id: `owner-${release.nextId}`, name: name.trim(), role: role.trim(), stage }
  return { release: { ...release, owners: [...release.owners, owner], nextId: release.nextId + 1 } }
}

function entryLine(entry: ChangelogEntry): string {
  return entry.scope ? `**${entry.scope}:** ${entry.description}` : entry.description
}

export function targetVersion(release: Release): string {
  return release.shipped ? release.shipped.version : nextVersion(release)
}

export function changelogMarkdown(release: Release): string {
  const date = release.releaseDate ? release.releaseDate.slice(0, 10) : "unscheduled"
  const header = `## v${targetVersion(release)} (${date})`
  if (release.changelog.length === 0) return `${header}\n\n_No entries yet._`
  const sections = CHANGE_TYPES.flatMap((type) => {
    const entries = release.changelog.filter((entry) => entry.type === type)
    return entries.length === 0 ? [] : [`### ${CHANGE_HEADINGS[type]}\n\n${entries.map((entry) => `- ${entryLine(entry)}`).join("\n")}`]
  })
  return [header, ...sections].join("\n\n")
}

export function conventionalCommits(entries: readonly ChangelogEntry[]): string {
  return entries.map((entry) => `${entry.type}${entry.scope ? `(${entry.scope})` : ""}: ${entry.description}`).join("\n")
}

export function announcementPrompt(release: Release): string {
  const owners = release.owners.map((owner) => `- ${owner.name}, ${owner.role} (${STAGE_TITLES[owner.stage]})`).join("\n")
  return [
    `Draft the public announcement for release v${targetVersion(release)}${release.releaseDate ? `, going out on ${release.releaseDate.replace("T", " at ")}` : ""}.`,
    "Write a short blog post and a three-sentence newsletter blurb. Lead with the most user-visible features, group fixes briefly, and leave chores out unless they change behaviour.",
    "Changelog:",
    changelogMarkdown(release),
    "Release owners:",
    owners,
  ].join("\n\n")
}

export function defaultReleaseDate(now: number): string {
  const date = new Date(now)
  date.setDate(date.getDate() + 7)
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T10:00`
}
