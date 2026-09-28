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
import type { HarnessCapabilities } from "@claxedo/agent-sdk-runtime"
import type { ConfigOptionsPreview, ConfigTarget, TurnActor } from "@claxedo/harness/contract"
import type { SessionAttachments } from "./attachments"
import { harnessCapabilitiesFor } from "./capabilities"
import type { AgentRuntimeHealth, AgentRuntimeStore } from "./contracts"
import { draftLaunch, type LaunchComposer } from "./launch"
import type { HarnessHandle, TransportResolver } from "./transports"

/** A harness read that names a live session or a draft on a harness in a directory. */
export type HarnessTarget =
  | { sessionId: string; directory?: string }
  | { harness: SessionHarness; directory: string; owner?: TurnActor }

type ResolvedTarget = { handle: HarnessHandle; target: ConfigTarget; sessionId?: string; directory: string }

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
      const attached = await attachments.for(target.sessionId, target.directory)
      return { handle: attached.handle, target: { session: attached.session }, sessionId: target.sessionId, directory: attached.session.directory }
    }
    const handle = await transports.forHarness(target.harness, target.directory)
    const draft = draftLaunch(launch, { harness: target.harness, directory: target.directory, locality: handle.locality,
      owner: target.owner ?? { kind: "machine-owner" } })
    return { handle, target: { draft }, directory: target.directory }
  }

  const declaredFor = (resolved: ResolvedTarget) =>
    resolved.handle.transport.capabilities({ directory: resolved.directory, ...(resolved.sessionId ? { sessionId: resolved.sessionId } : {}) })

  return {
    async capabilities(target: HarnessTarget): Promise<HarnessCapabilities> {
      const resolved = await resolve(target)
      const declared = await declaredFor(resolved)
      const child = !!resolved.sessionId && !!store.getSession(resolved.sessionId)?.parentID
      return harnessCapabilitiesFor(resolved.handle, resolved.handle.transport, declared, { child })
    },
    async configOptions(target: HarnessTarget, model?: PromptModel): Promise<ConfigOptionsPreview | undefined> {
      const resolved = await resolve(target)
      const config = resolved.handle.transport.config
      if (!config) return undefined
      if ("session" in resolved.target) return await config.options({ session: resolved.target.session, ...(model ? { model } : {}) }, "probe")
      return await config.options({ draft: { ...resolved.target.draft, ...(model ? { model } : {}) } }, "probe")
    },
    async permissionModes(target: HarnessTarget): Promise<AgentPermissionModeState | undefined> {
      const resolved = await resolve(target)
      return await resolved.handle.transport.config?.permissionModes(resolved.target)
    },
    async setPermissionMode(sessionId: string, modeId: string, directory?: string): Promise<AgentPermissionModeState | undefined> {
      const attached = await attachments.for(sessionId, directory)
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
    async todos(sessionId: string, directory?: string): Promise<readonly AgentTodo[] | undefined> {
      const attached = await attachments.for(sessionId, directory)
      return await attached.handle.transport.history?.todos(attached.session)
    },
    async messages(sessionId: string, directory?: string): Promise<readonly AgentMessage[] | undefined> {
      const attached = await attachments.for(sessionId, directory)
      return await attached.handle.transport.history?.messages(attached.session)
    },
    async sessionConfig(sessionId: string, directory?: string): Promise<SessionConfig> {
      const attached = await attachments.for(sessionId, directory)
      const declared = await attached.handle.transport.capabilities({ directory: attached.session.directory, sessionId })
      if (declared.configOwner === "harness" && attached.handle.transport.config) return await attached.handle.transport.config.read(attached.session)
      const config = store.getSessionConfig(sessionId)
      if (!config) throw new Error(`Session ${sessionId} has no runtime config`)
      return config
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
