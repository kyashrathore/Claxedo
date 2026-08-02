import { describe, expect, test } from "bun:test"
import { resolveSubmitDirectory } from "./resolve"
import type { ResolveSubmitDirectoryContext } from "./types"
import { resolveWorkspaceSubmitPlan } from "../composer/workspace-resolver"

// resolveSubmitDirectory (orchestrator, imperative + callbacks) and
// resolveWorkspaceSubmitPlan (pure sub-decision) independently encode the SAME
// shared top-level admission tree. This property test drives both over a matrix
// of shared inputs and proves they never disagree on which branch fires — the
// exact silent-divergence risk the audit flagged (two hand-maintained decision
// trees). Remote sub-decisions (prepare vs provision vs missing) belong to the
// plan alone and are not compared here; only the shared branch classification is.

type SharedDecision = "reuse" | "missing-workspace" | "remote-handled" | "create-local" | { ready: string }

const DEFAULT_DIR = "/default/dir"

type Input = {
  isNewSession: boolean
  draftId?: string
  projectDirectory?: string
  fallbackDirectory?: string
  worktreeSelection: string
  workspaceKind: string
}

// Both functions check this shared precondition FIRST, before any remote
// handling, so a hit here is a shared "missing-workspace" outcome (not a remote
// sub-decision).
function isTopDraftMissing(input: Input) {
  return input.isNewSession && !!input.draftId && !input.projectDirectory && input.worktreeSelection === "main"
}

function isRemoteKind(kind: string) {
  return kind === "cloud" || kind === "user-hosted"
}

function classifyPlan(input: Input): SharedDecision {
  const plan = resolveWorkspaceSubmitPlan({
    isNewSession: input.isNewSession,
    defaultDirectory: DEFAULT_DIR,
    worktreeSelection: input.worktreeSelection,
    workspaceKind: input.workspaceKind,
    projects: [],
    ...(input.draftId === undefined ? {} : { draftId: input.draftId }),
    ...(input.projectDirectory === undefined ? {} : { projectDirectory: input.projectDirectory }),
    ...(input.fallbackDirectory === undefined ? {} : { fallbackDirectory: input.fallbackDirectory }),
  })
  switch (plan.status) {
    case "ready":
      // A not-new session "reuses" its directory; a new session "readies" one.
      return input.isNewSession ? { ready: plan.directory } : "reuse"
    case "missing-workspace":
      // Distinguish the shared top-level draft-missing check (which the
      // orchestrator also performs before delegating) from a remote
      // sub-decision the orchestrator delegates wholesale to this plan.
      if (isTopDraftMissing(input)) return "missing-workspace"
      return isRemoteKind(input.workspaceKind) ? "remote-handled" : "missing-workspace"
    case "create-local-worktree":
      return "create-local"
    case "prepare-remote-workspace":
    case "provision-cloud-workspace":
      return "remote-handled"
  }
}

async function classifyOrchestrator(input: {
  isNewSession: boolean
  draftId?: string
  projectDirectory?: string
  fallbackDirectory?: string
  worktreeSelection: string
  workspaceKind: string
}): Promise<SharedDecision> {
  let missing = false
  let remote = false
  let createLocal = false
  const context: ResolveSubmitDirectoryContext = {
    isNewSession: input.isNewSession,
    defaultDirectory: DEFAULT_DIR,
    worktreeSelection: input.worktreeSelection,
    workspaceKind: input.workspaceKind,
    ...(input.draftId === undefined ? {} : { draftId: input.draftId }),
    ...(input.projectDirectory === undefined ? {} : { projectDirectory: input.projectDirectory }),
    ...(input.fallbackDirectory === undefined ? {} : { fallbackDirectory: input.fallbackDirectory }),
    showMissingWorkspace: () => {
      missing = true
    },
    resolveCloudSessionDirectory: async () => {
      remote = true
      return undefined
    },
    prepareCloudSessionDirectory: async () => true,
    createLocalWorktree: async () => {
      createLocal = true
      return undefined
    },
    publishCloudHandoff: () => {},
  }
  const result = await resolveSubmitDirectory(context)
  if (missing) return "missing-workspace"
  if (remote) return "remote-handled"
  if (createLocal) return "create-local"
  if (!result) return "missing-workspace"
  return input.isNewSession ? { ready: result.directory } : "reuse"
}

const worktreeSelections = ["main", "create", "/explicit/worktree"]
const workspaceKinds = ["local", "cloud", "user-hosted"]
const directoryVariants: Array<{ projectDirectory?: string; fallbackDirectory?: string }> = [
  {},
  { projectDirectory: "/proj/dir" },
  { fallbackDirectory: "/fallback/dir" },
  { projectDirectory: "/proj/dir", fallbackDirectory: "/fallback/dir" },
]

describe("submit-directory resolvers agree on the shared admission tree", () => {
  for (const isNewSession of [true, false]) {
    for (const draftId of [undefined, "draft-1"]) {
      for (const worktreeSelection of worktreeSelections) {
        for (const workspaceKind of workspaceKinds) {
          for (const dirs of directoryVariants) {
            const input = { isNewSession, draftId, worktreeSelection, workspaceKind, ...dirs }
            const label = JSON.stringify(input)
            test(`orchestrator matches plan for ${label}`, async () => {
              const [plan, orchestrator] = await Promise.all([
                Promise.resolve(classifyPlan(input)),
                classifyOrchestrator(input),
              ])
              expect(orchestrator).toEqual(plan)
            })
          }
        }
      }
    }
  }
})
