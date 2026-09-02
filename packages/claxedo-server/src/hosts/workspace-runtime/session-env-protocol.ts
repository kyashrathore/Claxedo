import type { SessionEnvExecOptions, SessionEnvExecResult } from "@claxedo/agent-sdk-runtime"
import {
  decodeSessionEnvExecFrame,
  SESSION_ENV_EXEC_MAX_FRAME_BYTES,
  SESSION_ENV_EXEC_MAX_OUTPUT_BYTES,
  type SessionEnvExecFrame,
  WorkspaceRuntimeProtocolError,
} from "@claxedo/workspace-runtime/session-env-contract"
import {
  workspaceRuntimeRequestError,
  WorkspaceRuntimeRequestError,
} from "@claxedo/server-core/workspace/http/workspace-runtime-client"

export { WorkspaceRuntimeProtocolError, WorkspaceRuntimeRequestError }

export class WorkspaceRuntimeExecLimitError extends Error {
  readonly code: "workspace_runtime_exec_frame_limit" | "workspace_runtime_exec_output_limit"
  readonly limitBytes: number

  constructor(input: {
    code: "workspace_runtime_exec_frame_limit" | "workspace_runtime_exec_output_limit"
    limitBytes: number
  }) {
    super(
      input.code === "workspace_runtime_exec_frame_limit"
        ? `workspace-runtime exec frame exceeded ${input.limitBytes} bytes`
        : `workspace-runtime exec output exceeded ${input.limitBytes} bytes`,
    )
    this.name = "WorkspaceRuntimeExecLimitError"
    this.code = input.code
    this.limitBytes = input.limitBytes
  }
}

export async function requireWorkspaceRuntimeResponse(operation: string, response: Response) {
  if (!response.ok) throw await workspaceRuntimeRequestError(operation, response)
  return response
}

export async function readWorkspaceRuntimeJson<T>(
  operation: string,
  response: Response,
  decode: (input: unknown) => T,
): Promise<T> {
  let body: unknown
  try {
    body = await response.json()
  } catch (cause) {
    throw new WorkspaceRuntimeProtocolError(operation, cause)
  }
  return decode(body)
}

export async function foldExecStream(
  response: Response,
  options: SessionEnvExecOptions | undefined,
  outputLimitBytes = SESSION_ENV_EXEC_MAX_OUTPUT_BYTES,
): Promise<SessionEnvExecResult> {
  if (!response.body) throw new WorkspaceRuntimeProtocolError("exec body")
  if (!Number.isSafeInteger(outputLimitBytes) || outputLimitBytes < 1) {
    throw new RangeError("workspace-runtime exec output limit must be a positive safe integer")
  }
  const reader = response.body.getReader()
  const lineDecoder = new TextDecoder()
  const stdoutDecoder = new TextDecoder("utf-8", { fatal: false })
  const stderrDecoder = new TextDecoder("utf-8", { fatal: false })
  const byteCounter = new TextEncoder()
  let buffered = ""
  let stdout = ""
  let stderr = ""
  let outputBytes = 0
  let exit: Extract<SessionEnvExecFrame, { type: "exit" }> | undefined
  let completed = false

  const handle = (raw: unknown) => {
    const frame = decodeSessionEnvExecFrame(raw)
    if (frame.type === "stdout" || frame.type === "stderr") {
      const bytes = Buffer.from(frame.data, "base64")
      outputBytes += bytes.byteLength
      if (outputBytes > outputLimitBytes) {
        throw new WorkspaceRuntimeExecLimitError({
          code: "workspace_runtime_exec_output_limit",
          limitBytes: outputLimitBytes,
        })
      }
      const decoder = frame.type === "stdout" ? stdoutDecoder : stderrDecoder
      const text = decoder.decode(bytes, { stream: true })
      if (!text) return
      if (frame.type === "stdout") {
        stdout += text
        options?.onStdout?.(text)
      } else {
        stderr += text
        options?.onStderr?.(text)
      }
      return
    }
    if (frame.type === "error") throw new Error(frame.error)
    exit = frame
  }

  const handleLine = (line: string) => {
    if (byteCounter.encode(line).byteLength > SESSION_ENV_EXEC_MAX_FRAME_BYTES) {
      throw new WorkspaceRuntimeExecLimitError({
        code: "workspace_runtime_exec_frame_limit",
        limitBytes: SESSION_ENV_EXEC_MAX_FRAME_BYTES,
      })
    }
    try {
      handle(JSON.parse(line))
    } catch (cause) {
      if (cause instanceof WorkspaceRuntimeProtocolError || cause instanceof WorkspaceRuntimeExecLimitError) throw cause
      if (cause instanceof SyntaxError) throw new WorkspaceRuntimeProtocolError("exec frame", cause)
      throw cause
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffered += lineDecoder.decode(value, { stream: true })
      let newline = buffered.indexOf("\n")
      while (newline >= 0) {
        const line = buffered.slice(0, newline).trim()
        buffered = buffered.slice(newline + 1)
        if (line) handleLine(line)
        newline = buffered.indexOf("\n")
      }
      if (byteCounter.encode(buffered).byteLength > SESSION_ENV_EXEC_MAX_FRAME_BYTES) {
        throw new WorkspaceRuntimeExecLimitError({
          code: "workspace_runtime_exec_frame_limit",
          limitBytes: SESSION_ENV_EXEC_MAX_FRAME_BYTES,
        })
      }
    }
    const tail = `${buffered}${lineDecoder.decode()}`.trim()
    if (tail) handleLine(tail)
    const stdoutTail = stdoutDecoder.decode()
    if (stdoutTail) {
      stdout += stdoutTail
      options?.onStdout?.(stdoutTail)
    }
    const stderrTail = stderrDecoder.decode()
    if (stderrTail) {
      stderr += stderrTail
      options?.onStderr?.(stderrTail)
    }
    if (!exit) throw new WorkspaceRuntimeProtocolError("exec exit")
    if (exit.timedOut) throw new Error("command timed out")
    if (exit.canceled) throw new Error("command canceled")
    completed = true
    return {
      stdout,
      stderr,
      exitCode: exit.exitCode ?? (exit.signal ? 1 : 0),
    }
  } finally {
    if (!completed) await reader.cancel().catch(() => {})
  }
}
