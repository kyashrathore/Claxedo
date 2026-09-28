import type {
  AgentAgent,
  RuntimeCommand,
  SavedCommand,
  AgentMessage,
  AgentPermissionModeState,
  AgentTodo,
  ConnectionRuntimeStatus,
  PromptModel,
  SessionConfig,
  SessionHarness,
} from "@claxedo/agent-runtime-contract"
import { harnessKey } from "@claxedo/agent-runtime-contract"
import type { ConnectionSecretAuthority, HarnessCapabilities } from "@claxedo/agent-sdk-runtime"
import type { ConfigOptionsPreview, ConfigTarget, HarnessSession, TurnActor } from "@claxedo/harness/contract"
import type { SessionAttachments } from "./attachments"
import { harnessCapabilitiesFor } from "./capabilities"
import type { AgentRuntimeHealth, AgentRuntimeStore } from "./contracts"
import { draftLaunch, type LaunchComposer } from "./launch"
import type { HarnessHandle, TransportResolver } from "./transports"

/** A harness read that names a live session or a draft on a harness in a directory. */
export type HarnessTarget =
  | { sessionId: string; directory?: string; secretAuthority?: ConnectionSecretAuthority }
  | { harness: SessionHarness; directory: string; owner: TurnActor; secretAuthority?: ConnectionSecretAuthority }

type ResolvedTarget = { handle: HarnessHandle; target: ConfigTarget; sessionId?: string; directory: string }

export class PreviewModelInvalidError extends Error {
  constructor(requested: string) {
    super(`${requested} is not a provider/model identifier`)
    this.name = "PreviewModelInvalidError"
  }
}

function providerQualifiedModel(requested: string): PromptModel {
  const slash = requested.indexOf("/")
  if (slash < 1 || slash === requested.length - 1) throw new PreviewModelInvalidError(requested)
  return { providerID: requested.slice(0, slash), modelID: requested.slice(slash + 1) }
}

export function createHarnessReads(input: {
  store: AgentRuntimeStore
  transports: TransportResolver
  launch: LaunchComposer
  attachments: SessionAttachments
  savedCommands: () => readonly SavedCommand[]
}) {
  const { store, transports, launch, attachments } = input

  const resolve = async (target: HarnessTarget): Promise<ResolvedTarget> => {
    if ("sessionId" in target) {
      const attached = await attachments.for(target.sessionId, target.directory, undefined, target.secretAuthority)
      return { handle: attached.handle, target: { session: attached.session }, sessionId: target.sessionId, directory: attached.session.directory }
    }
    const handle = await transports.forHarness(target.harness, target.directory, {
      owner: target.owner, ...(target.secretAuthority ? { authority: target.secretAuthority } : {}),
    })
    const draft = draftLaunch(launch, { harness: target.harness, directory: target.directory, locality: handle.locality,
      owner: target.owner })
    return { handle, target: { draft }, directory: target.directory }
  }

  const sessionConfigOf = async (handle: HarnessHandle, session: HarnessSession): Promise<SessionConfig> => {
    const sessionId = session.binding.sessionId
    const declared = await handle.transport.capabilities({ directory: session.directory, sessionId })
    if (declared.configOwner === "harness" && handle.transport.config) return await handle.transport.config.read(session)
    const config = store.getSessionConfig(sessionId)
    if (!config) throw new Error(`Session ${sessionId} has no runtime config`)
    return config
  }

  const previewModel = async (resolved: ResolvedTarget, requested: string): Promise<PromptModel> => {
    if (resolved.handle.transport.providerCatalog) return providerQualifiedModel(requested)
    if ("draft" in resolved.target) {
      const harness = resolved.target.draft.config.harness
      return { providerID: harnessKey(harness) ?? harness.id, modelID: requested }
    }
    const config = await sessionConfigOf(resolved.handle, resolved.target.session)
    return { providerID: config.model?.providerID ?? harnessKey(config.harness) ?? config.harness.id, modelID: requested }
  }

  const declaredFor = (resolved: ResolvedTarget) =>
    resolved.handle.transport.capabilities({ directory: resolved.directory, ...(resolved.sessionId ? { sessionId: resolved.sessionId } : {}) })

  return {
    async providerCatalog(target: Extract<HarnessTarget, { harness: SessionHarness }>) {
      const resolved = await resolve(target)
      const catalog = resolved.handle.transport.providerCatalog
      if (!catalog || !("draft" in resolved.target)) throw new Error("Harness does not expose a provider catalog")
      return await catalog.providers(resolved.target.draft)
    },
    sessionOwner: (sessionId: string): TurnActor => attachments.owner(sessionId),
    async capabilities(target: HarnessTarget): Promise<HarnessCapabilities> {
      const resolved = await resolve(target)
      const declared = await declaredFor(resolved)
      const child = !!resolved.sessionId && !!store.getSession(resolved.sessionId)?.parentID
      return harnessCapabilitiesFor(resolved.handle, resolved.handle.transport, declared, { child })
    },
    async servesProviderCatalog(target: HarnessTarget): Promise<boolean> {
      return !!(await resolve(target)).handle.transport.providerCatalog
    },
    async configOptions(target: HarnessTarget, requested?: string): Promise<ConfigOptionsPreview | undefined> {
      const resolved = await resolve(target)
      const config = resolved.handle.transport.config
      if (!config) return undefined
      const model = requested === undefined ? undefined : await previewModel(resolved, requested)
      if ("session" in resolved.target) {
        const current = model ?? ((await declaredFor(resolved)).configOwner === "runtime"
          ? store.getSessionConfig(resolved.target.session.binding.sessionId)?.model : undefined)
        return await config.options({ session: resolved.target.session, ...(current ? { model: current } : {}) }, "probe")
      }
      return await config.options({ draft: { ...resolved.target.draft, ...(model ? { model } : {}) } }, "probe")
    },
    async permissionModes(target: HarnessTarget): Promise<AgentPermissionModeState | undefined> {
      const resolved = await resolve(target)
      return await resolved.handle.transport.config?.permissionModes(resolved.target)
    },
    async setPermissionMode(sessionId: string, modeId: string, directory?: string,
      authority?: ConnectionSecretAuthority): Promise<AgentPermissionModeState | undefined> {
      const attached = await attachments.for(sessionId, directory, undefined, authority)
      const config = attached.handle.transport.config
      if (!config) return undefined
      const state = await config.setPermissionMode(attached.session, modeId)
      const declared = await attached.handle.transport.capabilities({ directory: attached.session.directory, sessionId })
      if (declared.configOwner === "runtime" && !state.unsupported) store.updateSessionConfig(sessionId, { permissionMode: state.currentModeId ?? null })
      return state
    },
    async commands(target: HarnessTarget): Promise<readonly RuntimeCommand[]> {
      const resolved = await resolve(target)
      const commands = resolved.handle.transport.commands
      const declared = commands ? await commands.list(resolved.target) : []
      const saved = input.savedCommands()
      return [
        ...saved.map((command) => ({ ...command, origin: "saved" as const })),
        ...declared.map((command) => ({ ...command, origin: "transport" as const })),
      ]
    },
    async agents(target: HarnessTarget): Promise<readonly AgentAgent[] | undefined> {
      const resolved = await resolve(target)
      return await resolved.handle.transport.agents?.list(resolved.target)
    },
    async todos(sessionId: string, directory?: string, authority?: ConnectionSecretAuthority): Promise<readonly AgentTodo[] | undefined> {
      const attached = await attachments.for(sessionId, directory, undefined, authority)
      return await attached.handle.transport.history?.todos(attached.session)
    },
    async messages(sessionId: string, directory?: string, authority?: ConnectionSecretAuthority): Promise<readonly AgentMessage[] | undefined> {
      const attached = await attachments.for(sessionId, directory, undefined, authority)
      return await attached.handle.transport.history?.messages(attached.session)
    },
    async sessionConfig(sessionId: string, directory?: string, authority?: ConnectionSecretAuthority): Promise<SessionConfig> {
      const attached = await attachments.for(sessionId, directory, undefined, authority)
      return await sessionConfigOf(attached.handle, attached.session)
    },
    health(directory: string): AgentRuntimeHealth[] {
      return transports.composed().flatMap((handle) => {
        const status = handle.transport.health?.runtime(directory)
        return status ? [status] : []
      })
    },
    sessionHealth(sessionId: string, directory: string): AgentRuntimeHealth {
      const attached = attachments.peek(sessionId)
      return attached?.handle.transport.health?.runtime(directory, sessionId) ?? { status: "ok" }
    },
    connectionState(sessionId: string | undefined, directory: string, handle: HarnessHandle | undefined): ConnectionRuntimeStatus {
      const target = sessionId ? attachments.peek(sessionId)?.handle ?? handle : handle
      return target?.transport.health?.connection(directory, sessionId) ?? { state: "configured", processes: [] }
    },
  }
}
