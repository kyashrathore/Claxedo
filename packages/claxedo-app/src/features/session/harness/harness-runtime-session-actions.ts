import { createOpencodeClient as defaultCreateOpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { HarnessScopeInput } from "./store-policy"
import type {
  PreparedRuntimeSession,
  PreparedRuntimeSessionConfig,
  PreparedSessionDirectory,
} from "./prepared-session"
import type { HarnessType } from "./profile"
import { harnessQueryFetch } from "@/platform/runtime/harness-query-fetch"

type HarnessRuntimeSessionClient = {
  session: {
    create(input: {
      directory: PreparedSessionDirectory
      agent: string
      model: { providerID: string; id: string; variant?: string }
    }): Promise<{ data?: { id?: string } }>
    delete(input: { directory: PreparedSessionDirectory; sessionID: string }): Promise<unknown>
  }
}

type CreateHarnessRuntimeSessionClient = (input: {
  baseUrl: string
  fetch: typeof fetch
  directory: PreparedSessionDirectory
  throwOnError?: boolean
}) => HarnessRuntimeSessionClient

type HarnessRuntimeSessionRuntime<ScopeInput extends HarnessScopeInput> = {
  useLocalHarnessConfig(input?: ScopeInput): boolean
  harnessSessionFetch(input?: ScopeInput): typeof fetch
  /** The relay-backed workspace the inventory describes for a scope, if any. */
  workspaceRef(input?: ScopeInput): { workspaceId: string } | undefined
}

export function createHarnessRuntimeSessionActions<ScopeInput extends HarnessScopeInput & { sessionConfig: PreparedRuntimeSessionConfig }>(input: {
  base: string
  runtime: HarnessRuntimeSessionRuntime<ScopeInput>
  createClient?: CreateHarnessRuntimeSessionClient
}) {
  const createClient = input.createClient ?? (defaultCreateOpencodeClient as CreateHarnessRuntimeSessionClient)

  const canUseRuntimeSession = (params?: ScopeInput) =>
    input.runtime.useLocalHarnessConfig(params) || !!input.runtime.workspaceRef(params)

  const create = async (params: {
    input: ScopeInput
    directory: PreparedSessionDirectory
    harness: HarnessType
  }) => {
    const res = await createClient({
      baseUrl: input.base,
      fetch: harnessQueryFetch({
        request: input.runtime.harnessSessionFetch(params.input),
        harnessType: params.harness,
        baseUrl: input.base,
      }),
      directory: params.directory,
      throwOnError: true,
    }).session.create({
      directory: params.directory,
      agent: params.input.sessionConfig.agent,
      model: {
        providerID: params.input.sessionConfig.model.providerID,
        id: params.input.sessionConfig.model.modelID,
        ...(params.input.sessionConfig.variant ? { variant: params.input.sessionConfig.variant } : {}),
      },
    })
    return res.data?.id
  }

  const remove = async (item: PreparedRuntimeSession) => {
    if (!canUseRuntimeSession({ directory: item.directory } as ScopeInput)) return
    await createClient({
      baseUrl: input.base,
      fetch: input.runtime.harnessSessionFetch({ directory: item.directory } as ScopeInput),
      directory: item.directory,
    })
      .session.delete({
        directory: item.directory,
        sessionID: item.id,
      })
      .catch(() => {})
  }

  return {
    canUseRuntimeSession,
    create,
    remove,
  }
}
