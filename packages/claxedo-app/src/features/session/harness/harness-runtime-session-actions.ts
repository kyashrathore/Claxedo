import { createOpencodeClient as defaultCreateOpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { HarnessScopeInput } from "./store-policy"
import type {
  PreparedRuntimeSession,
  PreparedRuntimeSessionConfig,
  PreparedSessionDirectory,
} from "./prepared-session"
import { sessionHarnessIdentity, type HarnessType } from "./profile"
import { createAgentRuntimeClient } from "@/platform/runtime/agent/agent-runtime-client"

type HarnessRuntimeSessionClient = Pick<ReturnType<typeof createAgentRuntimeClient>, "createSession" | "deleteSession">

type CreateHarnessRuntimeSessionClient = (input: Parameters<typeof createAgentRuntimeClient>[0]) => HarnessRuntimeSessionClient

type HarnessRuntimeSessionRuntime<ScopeInput extends HarnessScopeInput> = {
  useLocalHarnessConfig(input?: ScopeInput): boolean
  harnessSessionFetch(input?: ScopeInput): typeof fetch
  /** The relay-backed workspace the inventory describes for a scope, if any. */
  workspaceRef(input?: ScopeInput): { workspaceId: string } | undefined
}

export function createHarnessRuntimeSessionActions<ScopeInput extends HarnessScopeInput & { sessionConfig: PreparedRuntimeSessionConfig }>(input: {
  base: string
  runtime: HarnessRuntimeSessionRuntime
  createClient?: CreateHarnessRuntimeSessionClient
}) {
  const createClient = input.createClient ?? createAgentRuntimeClient

  const canUseRuntimeSession = (params?: ScopeInput) =>
    input.runtime.useLocalHarnessConfig(params) || !!input.runtime.workspaceRef(params)

  const create = async (params: {
    input: ScopeInput
    directory: PreparedSessionDirectory
    harness: HarnessType
  }) => {
    const res = await createClient({
      serverUrl: input.base,
      request: input.runtime.harnessSessionFetch(params.input),
    }).createSession({
      directory: params.directory,
      harness: sessionHarnessIdentity(params.harness),
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
      request: input.runtime.harnessSessionFetch(scope),
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
