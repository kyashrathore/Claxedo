import path from "node:path"
import type { SessionEnv, SessionEnvExecOptions, SessionEnvFileStat } from "@claxedo/agent-sdk-runtime"
import {
  decodeSessionEnvExistsResponse,
  decodeSessionEnvMutationResponse,
  decodeSessionEnvReadFileResponse,
  decodeSessionEnvReaddirResponse,
  decodeSessionEnvStatResponse,
} from "@claxedo/workspace-runtime/session-env-contract"
import type { SandboxFetchOptions } from "@claxedo/server-core/workspace/http/sandbox-target-fetch"
import { createWorkspaceRuntimeClient } from "@claxedo/server-core/workspace/http/workspace-runtime-client"
import type { Workspace } from "@claxedo/server-core/workspace/store/index"
import { CONNECTION_TURN_HEADER } from "../../connections/turn-credentials"
import { disposeHydratedSessionDocuments, syncHydratedSessionDocuments } from "../../documents/session-hydration"
import { foldExecStream, readWorkspaceRuntimeJson, requireWorkspaceRuntimeResponse } from "./session-env-protocol"

const SESSION_ENV_BASE = "/api/wr/session-env"

export type WorkspaceRuntimeSessionEnvInput = {
  workspace: Workspace
  sessionId?: string
  directory?: string
  fetchOptions: SandboxFetchOptions
  connectionTurnCredential?: () => string | undefined
  onHydrationFailure?: (failure: SessionHydrationFailure) => void
  execOutputLimitBytes?: number
}

export type SessionHydrationFailure = Readonly<{
  phase: "end-turn" | "dispose"
  sessionId: string
  error: unknown
  documentId?: string
  path?: string
}>

export function createWorkspaceRuntimeSessionEnv(input: WorkspaceRuntimeSessionEnvInput): SessionEnv {
  const registeredRoot = nativeAbsoluteRoot(input.directory)
  const cwd = registeredRoot
    ? "/"
    : input.directory && input.directory.trim().length > 0
      ? path.posix.resolve("/", input.directory)
      : "/"
  const client = createWorkspaceRuntimeClient({
    workspace: input.workspace,
    options: input.fetchOptions,
    ...(registeredRoot ? { directory: registeredRoot } : {}),
    ...(input.connectionTurnCredential
      ? {
          headers: () => {
            const credential = input.connectionTurnCredential?.()
            return credential ? { [CONNECTION_TURN_HEADER]: credential } : undefined
          },
        }
      : {}),
  })
  const request = async (operation: string, requestPath: string, init?: RequestInit) => {
    return requireWorkspaceRuntimeResponse(operation, await client.request(requestPath, init))
  }
  const requestJson = async <T>(
    operation: string,
    requestPath: string,
    decode: (body: unknown) => T,
    init?: RequestInit,
  ) => readWorkspaceRuntimeJson(operation, await request(operation, requestPath, init), decode)
  const resolvePath = (value?: string) => path.posix.resolve(cwd, value ?? ".")
  const relative = (value?: string) => workspaceRelative(cwd, value)

  return {
    kind: "workspace-runtime",
    cwd() {
      return cwd
    },
    resolvePath,
    async exec(command: string, options?: SessionEnvExecOptions) {
      const response = await request("exec", `${SESSION_ENV_BASE}/exec`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          command,
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          ...(relative(options?.cwd) ? { cwd: relative(options?.cwd) } : {}),
          ...(options?.env ? { env: options.env } : {}),
          ...(options?.timeoutMs ? { timeout: options.timeoutMs } : {}),
        }),
        ...(options?.signal ? { signal: options.signal } : {}),
      })
      const result = await foldExecStream(response, options, input.execOutputLimitBytes)
      if (input.sessionId) {
        try {
          await syncHydratedSessionDocuments(input.sessionId)
        } catch (error) {
          reportHydrationFailure(input, { phase: "end-turn", sessionId: input.sessionId, error })
        }
      }
      return result
    },
    async readFile(filePath: string) {
      const body = await requestJson(
        "readFile",
        `${SESSION_ENV_BASE}/file/read?path=${encodeURIComponent(relative(filePath))}`,
        decodeSessionEnvReadFileResponse,
      )
      const buffer = Buffer.from(body.content, "base64")
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    },
    async writeFile(filePath: string, content: string | Uint8Array) {
      await requestJson(
        "writeFile",
        `${SESSION_ENV_BASE}/file/write`,
        (body) => decodeSessionEnvMutationResponse("writeFile", body),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            path: relative(filePath),
            content: Buffer.from(content).toString("base64"),
            encoding: "base64",
          }),
        },
      )
    },
    async stat(filePath: string): Promise<SessionEnvFileStat> {
      return requestJson(
        "stat",
        `${SESSION_ENV_BASE}/file/stat?path=${encodeURIComponent(relative(filePath))}`,
        decodeSessionEnvStatResponse,
      )
    },
    async readdir(filePath?: string) {
      return requestJson(
        "readdir",
        `${SESSION_ENV_BASE}/file/readdir?path=${encodeURIComponent(relative(filePath))}`,
        decodeSessionEnvReaddirResponse,
      )
    },
    async exists(filePath: string) {
      return (
        await requestJson(
          "exists",
          `${SESSION_ENV_BASE}/file/exists?path=${encodeURIComponent(relative(filePath))}`,
          decodeSessionEnvExistsResponse,
        )
      ).exists
    },
    async mkdir(filePath: string, options?: { recursive?: boolean }) {
      await requestJson(
        "mkdir",
        `${SESSION_ENV_BASE}/file/mkdir`,
        (body) => decodeSessionEnvMutationResponse("mkdir", body),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: relative(filePath), recursive: options?.recursive ?? true }),
        },
      )
    },
    async rm(filePath: string, options?: { recursive?: boolean; force?: boolean }) {
      await requestJson("rm", `${SESSION_ENV_BASE}/file/rm`, (body) => decodeSessionEnvMutationResponse("rm", body), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: relative(filePath),
          recursive: options?.recursive ?? false,
          force: options?.force ?? false,
        }),
      })
    },
    async dispose() {
      if (!input.sessionId) return
      for (const failure of await disposeHydratedSessionDocuments(input.sessionId)) {
        reportHydrationFailure(input, {
          phase: "dispose",
          sessionId: input.sessionId,
          documentId: failure.documentId,
          path: failure.path,
          error: failure.error,
        })
      }
    },
  }
}

function nativeAbsoluteRoot(directory: string | undefined) {
  const value = directory?.trim()
  if (!value) return undefined
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value) ? value : undefined
}

function workspaceRelative(cwd: string, input?: string) {
  return path.posix.resolve(cwd, input ?? ".").replace(/^\/+/, "")
}

function reportHydrationFailure(input: WorkspaceRuntimeSessionEnvInput, failure: SessionHydrationFailure) {
  if (!input.onHydrationFailure) {
    console.error(`[session-env] document hydration ${failure.phase} failed for ${failure.sessionId}:`, failure.error)
    return
  }
  try {
    input.onHydrationFailure(failure)
  } catch (error) {
    console.error(`[session-env] document hydration failure reporter failed for ${failure.sessionId}:`, error)
  }
}
