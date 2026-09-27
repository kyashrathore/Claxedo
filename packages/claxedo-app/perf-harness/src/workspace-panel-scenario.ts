import type { WorkspaceFixtureManifest } from "agent-app-benchmark/driver-sdk"

import type { SessionReadinessTarget } from "./agent-browser-observer"

export const READINESS_TIMEOUT_MS = 30_000

export type PanelProfile = "closed" | "files" | "diff"
export const PUBLIC_PANEL_LOAD_PROFILES = ["light", "moderate", "heavy"] as const
export const SESSION_NAVIGATION_TYPES = [
  "first-visit",
  "return-visited-panel-closed",
  "return-visited-panel-open",
] as const

type PublicPanelLoadProfile = (typeof PUBLIC_PANEL_LOAD_PROFILES)[number]
type SessionNavigationType = (typeof SESSION_NAVIGATION_TYPES)[number]

export type PublicPanelLoadPreset = {
  id: PublicPanelLoadProfile
  expandedDirectoryCount: number
  retainedFileTabCount: number
  expandedReviewFileCount: number
}

export const REVIEW_SCROLL_SELECTOR =
  "[data-slot='session-review-scroll'][data-scrollable], [data-slot='session-review-scroll'] [data-scrollable]"
export const COLLAPSE_ALL_SELECTOR = "button[aria-label='Collapse all']"

export type PublicPanelLoadPresets = Readonly<Record<PublicPanelLoadProfile, PublicPanelLoadPreset>>

export type SessionNavigationCase = {
  caseId: string
  workload: "session-navigation"
  trend: "history-size" | "panel-load"
  navigationType: SessionNavigationType
  transcriptBytes: number
  loadProfile?: PublicPanelLoadProfile
  sourceSessionId: string
  destinationSessionId: string
}

export const WORKSPACE_PANEL_ACTIONS = [
  "open-panel",
  "close-panel",
  "files-to-review",
  "review-to-files",
  "open-file",
  "switch-file-tab",
  "expand-all",
  "collapse-all",
] as const
type WorkspacePanelAction = (typeof WORKSPACE_PANEL_ACTIONS)[number]

export type WorkspacePanelCase = {
  caseId: string
  workload: "workspace-panel-interaction"
  action: WorkspacePanelAction
  loadProfile: PublicPanelLoadProfile
}

export type PanelTarget = SessionReadinessTarget & {
  logicalSessionId: string
  workspaceDirectory: string
}

export type FixtureEvidence = {
  manifest: WorkspaceFixtureManifest
  files: string[]
  changed: string[]
  openFiles: string[]
}

export function publicPanelLoadPresets(input: {
  scenarioDefinition?: Record<string, unknown>
  fixture: FixtureEvidence
}): PublicPanelLoadPresets {
  const cases = input.scenarioDefinition?.cases
  if (!cases || typeof cases !== "object" || Array.isArray(cases)) {
    throw new Error("Claxedo public panel scenario is missing cases")
  }
  const panelLoads = "panelLoads" in cases ? cases.panelLoads : undefined
  if (!Array.isArray(panelLoads)) {
    throw new Error("Claxedo public panel scenario is missing cases.panelLoads")
  }
  if (panelLoads.length !== PUBLIC_PANEL_LOAD_PROFILES.length) {
    throw new Error("Claxedo public panel scenario must define light, moderate, and heavy load presets")
  }
  const parsed = new Map<PublicPanelLoadProfile, PublicPanelLoadPreset>()
  for (const [index, raw] of panelLoads.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Claxedo public panel load preset must be an object")
    }
    const declaredId = "id" in raw ? raw.id : undefined
    const id = PUBLIC_PANEL_LOAD_PROFILES.find((profile) => profile === declaredId)
    if (!id) {
      throw new Error(`Claxedo public panel load preset has unknown id ${JSON.stringify(declaredId)}`)
    }
    if (id !== PUBLIC_PANEL_LOAD_PROFILES[index]) {
      throw new Error("Claxedo public panel load presets must be ordered light, moderate, heavy")
    }
    if (parsed.has(id)) throw new Error(`Claxedo public panel load preset ${id} is duplicated`)
    const integer = (name: keyof Omit<PublicPanelLoadPreset, "id">) => {
      const found = name in raw ? raw[name] : undefined
      if (typeof found !== "number" || !Number.isSafeInteger(found) || found <= 0) {
        throw new Error(`Claxedo public panel load preset ${id}.${name} must be a positive safe integer`)
      }
      return found
    }
    const preset: PublicPanelLoadPreset = {
      id,
      expandedDirectoryCount: integer("expandedDirectoryCount"),
      retainedFileTabCount: integer("retainedFileTabCount"),
      expandedReviewFileCount: integer("expandedReviewFileCount"),
    }
    if (preset.expandedDirectoryCount > input.fixture.manifest.directories.length) {
      throw new Error(`Claxedo public panel load preset ${id} expands more directories than the fixture owns`)
    }
    if (preset.retainedFileTabCount > input.fixture.openFiles.length) {
      throw new Error(`Claxedo public panel load preset ${id} retains more canonical tabs than the fixture owns`)
    }
    if (preset.expandedReviewFileCount > input.fixture.changed.length) {
      throw new Error(`Claxedo public panel load preset ${id} expands more reviews than the fixture owns`)
    }
    parsed.set(id, preset)
  }
  if (parsed.size !== PUBLIC_PANEL_LOAD_PROFILES.length) {
    throw new Error("Claxedo public panel scenario must define light, moderate, and heavy load presets")
  }
  // Built explicitly rather than through `Object.fromEntries`, whose return
  // type cannot express "one entry per profile" and so needed an assertion.
  const preset = (id: PublicPanelLoadProfile) => {
    const found = parsed.get(id)
    if (!found) throw new Error(`Claxedo public panel scenario is missing the ${id} load preset`)
    return found
  }
  return { light: preset("light"), moderate: preset("moderate"), heavy: preset("heavy") }
}

export function fixtureEvidence(manifest: WorkspaceFixtureManifest): FixtureEvidence {
  const files = manifest.files.map((file) => file.path)
  const changed = manifest.files.filter((file) => file.changed).map((file) => file.path)
  if (files.length === 0 || changed.length === 0 || manifest.openFilePaths.length < 2) {
    throw new Error("Claxedo public workspace fixture does not contain the required file identities")
  }
  return { manifest, files, changed, openFiles: [...manifest.openFilePaths] }
}
