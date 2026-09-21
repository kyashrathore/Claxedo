import type { HarnessScopeInput } from "./store-policy"
import type {
  PreparedRuntimeSession,
  PreparedRuntimeSessionConfig,
  PreparedSessionDirectory,
} from "./prepared-session"
import type { HarnessType } from "./profile"
import { createAgentRuntimeClient } from "@/platform/runtime/agent/agent-runtime-client"

type HarnessRuntimeSessionClient = Pick<ReturnType<typeof createAgentRuntimeClient>, "createSession" | "deleteSession">

type CreateHarnessRuntimeSessionClient = (input: Parameters<typeof createAgentRuntimeClient>[0]) => HarnessRuntimeSessionClient

type HarnessRuntimeSessionRuntime<ScopeInput extends HarnessScopeInput> = {
  useLocalHarnessConfig(input?: ScopeInput): boolean
  harnessSessionFetch(input?: ScopeInput): typeof fetch
  /** The relay-backed workspace the inventory describes for a scope, if any. */
  workspaceRef(input?: ScopeInput): { workspaceId: string } | undefined
  agentRuntimeClientOptions(input?: HarnessScopeInput): Parameters<typeof createAgentRuntimeClient>[0]
}

/** The scope a prepared session creation carries: a harness scope plus the resolved config. */
type PreparedHarnessScopeInput = HarnessScopeInput & {
  sessionConfig: PreparedRuntimeSessionConfig
  headers?: Record<string, string>
}

export function createHarnessRuntimeSessionActions(input: {
  base: string
  runtime: HarnessRuntimeSessionRuntime<HarnessScopeInput>
  createClient?: CreateHarnessRuntimeSessionClient
}) {
  const createClient = input.createClient ?? createAgentRuntimeClient

  const canUseRuntimeSession = (params?: HarnessScopeInput) =>
    input.runtime.useLocalHarnessConfig(params) || !!input.runtime.workspaceRef(params)

  const create = async (params: {
    input?: PreparedHarnessScopeInput
    directory: PreparedSessionDirectory
    harness: HarnessType
  }) => {
    if (!params.input?.sessionConfig) throw new Error("Session creation requires resolved session configuration")
    const res = await createClient({
      serverUrl: input.base,
      ...input.runtime.agentRuntimeClientOptions(params.input),
    }).createSession({
      directory: params.directory,
      id: params.input.sessionId,
      headers: params.input.headers,
      harness: params.harness,
      agent: params.input.sessionConfig.agent,
      model: params.input.sessionConfig.model,
      ...(params.input.sessionConfig.variant ? { variant: params.input.sessionConfig.variant } : {}),
    })
    return res.data.id
  }

  const remove = async (item: PreparedRuntimeSession) => {
    const scope = { directory: item.directory }
    if (!canUseRuntimeSession(scope)) return
    await createClient({
      serverUrl: input.base,
      ...input.runtime.agentRuntimeClientOptions(scope),
    }).deleteSession({
      directory: item.directory,
      sessionID: item.id,
    })
  }

  return {
    canUseRuntimeSession,
    create,
    remove,
  }
}
