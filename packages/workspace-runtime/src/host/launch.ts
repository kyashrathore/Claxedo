import type { PromptModel, SessionConfig, SessionHarness } from "@claxedo/agent-runtime-contract"
import type { AttachInput, DraftLaunch, Locality, PluginProjection, ResolvedCredentials, StartInput, TurnActor } from "@claxedo/harness/contract"
import type { HarnessBinding } from "@claxedo/harness/contract"
import { HARNESS_TABLE, isHarnessId, PI_LAUNCH_PROVIDERS, piCredentialProviderIDs } from "@claxedo/agent-runtime-contract"
import { selectSessionCredentials, type CredentialSelectionInput } from "@claxedo/harness/registry"

/**
 * What the workspace composition knows and a session launch needs: the plugin
 * projection the accepted snapshot yields for a harness, the credentials every
 * session spends, and the workspace the launch belongs to.
 */
export type LaunchComposer = {
  workspaceId: string
  projection(harness: SessionHarness): PluginProjection
  credentials(): CredentialSelectionInput
}

export type SessionLaunch = {
  sessionId: string
  directory: string
  locality: Locality
  config: SessionConfig
  owner: TurnActor
  title?: string
  instructions?: string
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
    owner: session.owner,
  }
}

export function attachInput(launch: LaunchComposer, session: SessionLaunch, binding: HarnessBinding): AttachInput {
  const { title: _title, instructions: _instructions, ...rest } = startInput(launch, session)
  return { ...rest, binding }
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

export function sessionCredentials(launch: LaunchComposer, session: Pick<SessionLaunch, "owner" | "config">): ResolvedCredentials {
  const providerIds = accountProviderIds(session.config.harness, session.config.model)
  return selectSessionCredentials({ ...launch.credentials(), ...(providerIds ? { providerIds } : {}) }, session.owner)
}
