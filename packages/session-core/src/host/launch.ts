import type { PromptModel, SessionConfig, SessionHarness } from "@claxedo/agent-runtime-contract"
import type { AttachInput, DraftLaunch, Locality, PluginProjection, ResolvedCredentials, StartInput, TurnActor } from "@claxedo/harness/contract"
import type { HarnessBinding } from "@claxedo/harness/contract"
import { HARNESS_TABLE, isHarnessId, PI_LAUNCH_PROVIDERS, piCredentialProviderIDs } from "@claxedo/agent-runtime-contract"
import { selectSessionCredentials, sessionAccountOwner, type CredentialSelectionInput } from "@claxedo/harness/registry"

/**
 * What the workspace composition knows and a session launch needs: the plugin
 * projection the accepted snapshot yields for a harness, the credentials every
 * session spends, and the workspace the launch belongs to. A host that is
 * handed credentials only for the turn it runs answers none between turns: a
 * session it opens then holds no account, and its transport refuses a turn
 * that arrives without one.
 */
export type LaunchComposer = {
  providerDefinitions?(): StartInput["providerDefinitions"]
  workspaceId: string
  projection(harness: SessionHarness): PluginProjection
  credentials(): CredentialSelectionInput | undefined
}

export type SessionLaunch = {
  sessionId: string
  directory: string
  locality: Locality
  config: SessionConfig
  owner: TurnActor
  title?: string
  instructions?: string
  permissionModeKept?: StartInput["permissionModeKept"]
}

export function startInput(launch: LaunchComposer, session: SessionLaunch): StartInput {
  return {
    sessionId: session.sessionId,
    workspaceId: launch.workspaceId,
    directory: session.directory,
    locality: session.locality,
    ...(session.title !== undefined ? { title: session.title } : {}),
    ...(session.config.model ? { model: session.config.model } : {}),
    config: session.config,
    ...(session.instructions !== undefined ? { instructions: session.instructions } : {}),
    projection: launch.projection(session.config.harness),
    credentials: sessionCredentials(launch, session),
    providerDefinitions: launch.providerDefinitions?.(),
    owner: session.owner,
    ...(session.permissionModeKept ? { permissionModeKept: session.permissionModeKept } : {}),
  }
}

export function attachInput(launch: LaunchComposer, session: SessionLaunch, binding: HarnessBinding, upstreamHasTurns: boolean): AttachInput {
  const { title: _title, instructions: _instructions, ...rest } = startInput(launch, session)
  return { ...rest, binding, upstreamHasTurns }
}

export function draftLaunch(launch: LaunchComposer, input: {
  harness: SessionHarness
  directory: string
  locality: Locality
  owner: TurnActor
  model?: PromptModel
}): DraftLaunch {
  return {
    workspaceId: launch.workspaceId,
    directory: input.directory,
    locality: input.locality,
    ...(input.model ? { model: input.model } : {}),
    config: { harness: input.harness },
    projection: launch.projection(input.harness),
    credentials: sessionCredentials(launch, { owner: input.owner, config: { harness: input.harness, ...(input.model ? { model: input.model } : {}) } }),
    providerDefinitions: launch.providerDefinitions?.(),
    owner: input.owner,
  }
}

function accountProviderIds(harness: SessionHarness, model: PromptModel | undefined): readonly string[] | undefined {
  if (harness.access !== "native") return undefined
  if (isHarnessId(harness.id)) return HARNESS_TABLE[harness.id].providerIds
  if (harness.id === "pi") {
    const vendor = model?.providerID === "pi" ? model.modelID.split("/")[0] : undefined
    return vendor ? piCredentialProviderIDs(vendor) : PI_LAUNCH_PROVIDERS.flatMap(piCredentialProviderIDs)
  }
  return undefined
}

export function accountHolder(launch: LaunchComposer, owner: TurnActor): string {
  const snapshot = launch.credentials()
  if (snapshot) return sessionAccountOwner(snapshot, owner).userId
  return owner.kind === "person" ? owner.userId : "machine-owner"
}

/** Harnesses that spend an account handed over as its secret: Pi calls the vendor in process, Codex signs in with a ChatGPT plan's tokens. */
const DIRECT_HARNESSES: ReadonlySet<string> = new Set(["pi", "codex"])

export function sessionCredentials(launch: LaunchComposer, session: Pick<SessionLaunch, "owner" | "config">): ResolvedCredentials {
  const snapshot = launch.credentials()
  if (!snapshot) {
    return { accountOwner: accountHolder(launch, session.owner), machineLoginAllowed: false, providers: {}, secrets: {}, leaseGeneration: "" }
  }
  const { harness, model } = session.config
  const providerIds = accountProviderIds(harness, model)
  const directDelivery = harness.access === "native" && DIRECT_HARNESSES.has(harness.id)
  return selectSessionCredentials({ ...snapshot, ...(providerIds ? { providerIds } : {}), directDelivery }, session.owner)
}
