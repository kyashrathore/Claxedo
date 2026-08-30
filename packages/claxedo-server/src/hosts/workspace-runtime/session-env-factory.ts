import type { SessionEnvFactory, SessionEnvFactoryInput } from "@claxedo/agent-sdk-runtime"
import { createVirtualSessionEnv } from "@claxedo/agent-sdk-runtime"
import type { SandboxFetchOptions } from "@claxedo/server-core/workspace/http/sandbox-target-fetch"
import { resolveWorkspace, type Workspace } from "@claxedo/server-core/workspace/store/index"
import type { ConnectionTurnCredentials } from "../../connections/turn-credentials"
import { createWorkspaceRuntimeSessionEnv, type SessionHydrationFailure } from "./workspace-runtime-session-env"
import { prepareWorkspaceRuntimeSession } from "./workspace-session-admission"

export type WorkspaceResolver = (input: { workspaceId: string }) => Promise<Workspace | undefined>

export function createClaxedoSessionEnvFactory(options: {
  fetchOptions: SandboxFetchOptions
  resolveWorkspace?: WorkspaceResolver
  turnCredentials?: ConnectionTurnCredentials
  onHydrationFailure?: (failure: SessionHydrationFailure) => void
  prepareSession?: typeof prepareWorkspaceRuntimeSession
}): SessionEnvFactory {
  const resolve: WorkspaceResolver =
    options.resolveWorkspace ?? ((input) => resolveWorkspace({ workspaceId: input.workspaceId }))
  const connectionTurnCredential = options.turnCredentials ? () => options.turnCredentials?.current() : undefined
  return async (input: SessionEnvFactoryInput) => {
    const toolSandbox = input.toolSandbox
    if (toolSandbox?.kind !== "workspace-runtime") return createVirtualSessionEnv()
    const workspace = await resolve({ workspaceId: toolSandbox.workspaceId })
    if (!workspace) throw new Error(`workspace not found for tool sandbox: ${toolSandbox.workspaceId}`)
    const admitted = options.prepareSession
      ? await options.prepareSession({
          workspace,
          sessionId: input.sessionId,
          ...(toolSandbox.baseCommit ? { baseCommit: toolSandbox.baseCommit } : {}),
          fetchOptions: options.fetchOptions,
        })
      : undefined
    const directory = admitted?.directory ?? toolSandbox.directory
    return createWorkspaceRuntimeSessionEnv({
      workspace,
      sessionId: input.sessionId,
      ...(directory ? { directory } : {}),
      fetchOptions: options.fetchOptions,
      ...(connectionTurnCredential ? { connectionTurnCredential } : {}),
      ...(options.onHydrationFailure ? { onHydrationFailure: options.onHydrationFailure } : {}),
    })
  }
}
