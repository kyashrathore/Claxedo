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
import { isRelayBackedWorkspaceKind, workspaceKind } from "@/platform/runtime/agent/workspace-kind"

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

// `resolveSubmitDirectory` is the imperative ORCHESTRATOR: it owns the shared
// top-level admission tree (not-new → reuse; draft+"main"+no projectDirectory →
// missing-workspace; cloud/user-hosted → remote handling; "create" → local
// worktree; explicit worktreeSelection → use it; else → default) and turns each
// branch into a side effect (callbacks). The remote branch delegates the
// sub-decision (prepare existing vs provision cloud vs missing) to
// `resolveWorkspaceSubmitPlan` (session/composer/workspace-resolver.ts)
// via the `resolveCloudSessionDirectory` callback. Those two functions encode
// the SAME shared top-level tree independently, so `resolve-workspace-plan-agreement.test.ts`
// pins that they never diverge on shared inputs.
export async function resolveSubmitDirectory(
  input: ResolveSubmitDirectoryContext,
): Promise<SubmitDirectoryResult | undefined> {
  let sessionDirectory = input.projectDirectory ?? input.fallbackDirectory

  if (!input.isNewSession) {
    return { directory: sessionDirectory ?? input.defaultDirectory }
  }

  if (input.draftId && !input.projectDirectory && input.worktreeSelection === "main") {
    input.showMissingWorkspace()
    return
  }

  // user-hosted rides the same "resolve an existing remote workspace" path as
  // cloud: resolveCloudSessionDirectory/prepareCloudSessionDirectory detect a
  // user-hosted workspace and connect through the relay WITHOUT provisioning a
  // sandbox (see submit.ts existingCloudWorkspace / prepareUserHostedRuntime).
  // The cloud-startup overlay helpers self-gate to kind === "cloud", so they
  // no-op for user-hosted — its connection UI is owned by the WorkspaceGate.
  if (isRelayBackedWorkspaceKind(workspaceKind(input.workspaceKind))) {
    const cloudDirectory = await input.resolveCloudSessionDirectory(
      input.worktreeSelection,
      input.projectDirectory,
      input.fallbackDirectory,
      input.workspaceKind,
    )
    if (!cloudDirectory) return
    sessionDirectory = cloudDirectory
    const prepared = await input.prepareCloudSessionDirectory(sessionDirectory)
    if (!prepared) return
    if (typeof prepared === "string") sessionDirectory = prepared
    input.publishCloudHandoff("loading_models", "Runtime ready. Loading models.")
  } else if (input.worktreeSelection === "create") {
    const localDirectory = await input.createLocalWorktree(input.projectDirectory ?? input.fallbackDirectory)
    if (!localDirectory) return
    sessionDirectory = localDirectory
  } else if (input.worktreeSelection !== "main" && input.worktreeSelection !== "create") {
    sessionDirectory = input.worktreeSelection
  }

  if (input.draftId && !sessionDirectory) {
    input.showMissingWorkspace()
    return
  }

  return { directory: sessionDirectory ?? input.defaultDirectory }
}

export function resolveSubmitMode(input: { mode: SubmitMode; setMode: (mode: SubmitMode) => void }): "normal" {
  if (input.mode === "shell") input.setMode("normal")
  return "normal"
}

export function resolveSubmittedConfig(
  input: ResolveSubmittedConfigContext,
): SubmittedConfig | undefined {
  if (!input.harnessModelKey) return
  const variant = input.variant ?? input.harnessModelKey.variant
  return {
    model: { modelID: input.harnessModelKey.modelID, providerID: input.harnessModelKey.providerID },
    agent: resolveSubmitAgent(input),
    ...(variant ? { variant } : {}),
  }
}

function resolveSubmitAgent(input: ResolveSubmittedConfigContext) {
  if (input.agentOverride) return input.agentOverride
  if (input.currentAgent?.name && input.currentAgent.name !== "default") return input.currentAgent.name
  if (input.defaultAgent?.name && input.defaultAgent.name !== "default") return input.defaultAgent.name
  return "build"
}
