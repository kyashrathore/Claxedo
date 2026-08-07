// Phase boundaries that resolve "what session, where, in which mode, with
// what config, through which client" before any prompt is dispatched. Each
// helper is pure-ish in that it takes its dependencies via input rather than
// reading global state.
import type {
  ResolvePromptDispatchClientContext,
  ResolveSubmitDirectoryContext,
  ResolveSubmitSessionTargetContext,
  ResolveSubmittedConfigContext,
  ResolvedSubmitMode,
  SubmitDirectoryResult,
  SubmitMode,
  SubmitSessionTargetResult,
  SubmittedConfig,
} from "./types"

export async function resolveSubmitSessionTarget(
  input: ResolveSubmitSessionTargetContext,
): Promise<SubmitSessionTargetResult> {
  let session = input.session
  let replaceSession = input.replaceSession

  if (!session && input.explicitSessionID && !input.isNewSession) {
    session = await (input.harnessMode || input.signedControlPlane ? input.sessionClient() : input.client).session
      .get({ sessionID: input.explicitSessionID, directory: input.sessionDirectory })
      .then((x) => x.data ?? undefined)
      .catch(() => undefined)
    if (!session && (input.harnessMode || input.signedControlPlane)) {
      session = { id: input.explicitSessionID }
    }
    if (!session) replaceSession = true
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
  if (input.workspaceKind === "cloud" || input.workspaceKind === "user-hosted") {
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

// Rubric A3: `handleSubmit` used to do inline `text.startsWith("/")` /
// `mode === "shell"` checks at three different places to pick the dispatch
// branch. The branching is now centralised here so callers only switch on
// the returned mode. The slash-command list still has to be fetched by the
// caller (it depends on SDK + workspace context); the resolver only needs
// the resolved command name when one matches.
export type ResolveSubmitModeInput = {
  mode: SubmitMode
  harnessMode: boolean
  signedControlPlane: boolean
  setMode: (mode: SubmitMode) => void
  // Trimmed prompt text. Pass the raw user input here — the resolver checks
  // `startsWith("/")` and parses the command head; callers should NOT
  // pre-detect slashes themselves.
  text?: string
  // Names of available custom commands at the active directory. Pass an
  // empty array if commands have not loaded yet (resolver will fall back
  // to "normal"); pass `undefined` to skip the slash check entirely (used
  // by callers that handle slash detection out-of-band, e.g. legacy paths).
  customCommandNames?: readonly string[]
}

export type ResolveSubmitModeResult = {
  mode: ResolvedSubmitMode
  // Populated only when `mode === "slash"`. Contains the matched command
  // name (without leading "/") and the argument tail so the caller does
  // not have to re-split.
  slash?: { command: string; arguments: string }
}

export function resolveSubmitMode(input: ResolveSubmitModeInput): ResolveSubmitModeResult {
  // Shell mode falls back to normal under harness / signed control plane —
  // those transports do not expose a shell channel.
  if (input.mode === "shell" && (input.harnessMode || input.signedControlPlane)) {
    input.setMode("normal")
    return { mode: "normal" }
  }

  // Shell beats slash: an explicit shell toggle is a deliberate user
  // intent and should not be overridden by a leading "/".
  if (input.mode === "shell") return { mode: "shell" }

  if (input.customCommandNames && input.text && input.text.startsWith("/")) {
    const [cmdName, ...args] = input.text.split(" ")
    const commandName = cmdName.slice(1)
    if (input.customCommandNames.includes(commandName)) {
      return { mode: "slash", slash: { command: commandName, arguments: args.join(" ") } }
    }
  }

  return { mode: input.mode }
}

export async function resolveSubmittedConfig(
  input: ResolveSubmittedConfigContext,
): Promise<SubmittedConfig | undefined> {
  if (input.harnessMode) {
    if (!input.harnessModelKey) return
    const variant = input.variant ?? input.harnessModelKey.variant
    return {
      model: { modelID: input.harnessModelKey.modelID, providerID: input.harnessModelKey.providerID },
      agent: resolveSubmitAgent(input),
      ...(variant ? { variant } : {}),
    }
  }

  const model = input.selectedModel ?? (input.allowModelFallback ? input.fallbackModel : undefined)
  const currentModel = (model || input.allowModelFallback)
    ? await input.modelForSubmit(model)
    : undefined
  if (!currentModel) return
  return {
    model: { modelID: currentModel.id, providerID: currentModel.provider.id },
    agent: resolveSubmitAgent(input),
    ...(input.variant ? { variant: input.variant } : {}),
  }
}

function resolveSubmitAgent(input: ResolveSubmittedConfigContext) {
  if (input.agentOverride) return input.agentOverride
  if (input.currentAgent?.name && input.currentAgent.name !== "default") return input.currentAgent.name
  if (input.defaultAgent?.name && input.defaultAgent.name !== "default") return input.defaultAgent.name
  return "build"
}

export async function resolvePromptDispatchClient(input: ResolvePromptDispatchClientContext) {
  if (input.harnessMode || input.signedControlPlane || input.loopbackWorkspaceBridge) return input.sessionClient()
  return (await input.hostedSessionClient()) ?? input.fallbackClient
}
