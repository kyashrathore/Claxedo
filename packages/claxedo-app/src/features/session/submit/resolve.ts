// Phase boundaries that resolve "what session, where, in which mode, with
// what config, through which client" before any prompt is dispatched. Each
// helper is pure-ish in that it takes its dependencies via input rather than
// reading global state.
import type {
  ResolveSubmitDirectoryContext,
  ResolveSubmitSessionTargetContext,
  ResolveSubmittedConfigContext,
  SubmitDirectoryResult,
  SubmitMode,
  SubmitSessionTargetResult,
  SubmittedConfig,
} from "./types"
import { resolveWorkspaceSubmitSelection } from "../composer/workspace-submit-selection"

export async function resolveSubmitSessionTarget(
  input: ResolveSubmitSessionTargetContext,
): Promise<SubmitSessionTargetResult> {
  let session = input.session
  const replaceSession = input.replaceSession

  if (!session && input.explicitSessionID && !input.isNewSession) {
    session = await input.sessionClient().session
      .get({ sessionID: input.explicitSessionID, directory: input.sessionDirectory })
      .then((x) => x.data ?? undefined)
      .catch(() => undefined)
    if (!session) {
      session = { id: input.explicitSessionID }
    }
  }

  if (!session && replaceSession) {
    session = await input.createSessionTarget()
    return { session, replaceSession, created: !!session }
  }

  return { session, replaceSession, created: false }
}

/** Execute the selected directory plan; remote provisioning remains owned by its resolver callback. */
export async function resolveSubmitDirectory(
  input: ResolveSubmitDirectoryContext,
): Promise<SubmitDirectoryResult | undefined> {
  const selection = resolveWorkspaceSubmitSelection(input)
  if (selection.status === "missing-workspace") {
    input.showMissingWorkspace()
    return undefined
  }
  if (selection.status === "ready") return { directory: selection.directory }
  if (selection.status === "create-local-worktree") {
    const directory = await input.createLocalWorktree(selection.baseDirectory)
    return directory ? { directory } : undefined
  }
  const directory = await input.resolveCloudSessionDirectory(
    input.worktreeSelection,
    input.projectDirectory,
    input.fallbackDirectory,
    input.workspaceKind,
  )
  if (!directory) return undefined
  const prepared = await input.prepareCloudSessionDirectory(directory)
  if (!prepared) return undefined
  input.publishCloudHandoff("loading_models", "Runtime ready. Loading models.")
  return { directory: typeof prepared === "string" ? prepared : directory }
}

export function resolveSubmitMode(input: { mode: SubmitMode; setMode: (mode: SubmitMode) => void }): "normal" {
  if (input.mode === "shell") input.setMode("normal")
  return "normal"
}

export function resolveSubmittedConfig(
  input: ResolveSubmittedConfigContext,
): SubmittedConfig | undefined {
  if (!input.harnessModelKey) return undefined
  const variant = input.variant ?? input.harnessModelKey.variant
  return {
    model: { modelID: input.harnessModelKey.modelID, providerID: input.harnessModelKey.providerID },
    agent: resolveSubmitAgent(input),
    ...(variant ? { variant } : {}),
  }
}

function resolveSubmitAgent(input: ResolveSubmittedConfigContext) {
  if (input.agentOverride) return input.agentOverride
  const id = input.currentAgent?.id ?? input.currentAgent?.name
  if (id && id !== "default") return id
  const fallback = input.defaultAgent?.id ?? input.defaultAgent?.name
  if (fallback && fallback !== "default") return fallback
  return "build"
}
