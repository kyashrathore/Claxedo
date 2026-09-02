import { z } from "zod"

export const SESSION_ENV_EXEC_DEFAULT_TIMEOUT_MS = 10 * 60_000
export const SESSION_ENV_EXEC_MAX_TIMEOUT_MS = 60 * 60_000
export const SESSION_ENV_EXEC_MAX_FRAME_BYTES = 1024 * 1024
export const SESSION_ENV_EXEC_MAX_OUTPUT_BYTES = 16 * 1024 * 1024

export const SESSION_ENV_ERROR_CODES = [
  "session_env_command_required",
  "session_env_invalid_directory",
  "session_env_operation_failed",
  "session_env_path_forbidden",
  "session_env_pattern_required",
  "session_env_unsafe_regex",
] as const

export type SessionEnvErrorCode = (typeof SESSION_ENV_ERROR_CODES)[number]
export const SessionEnvErrorCodeSchema = z.enum(SESSION_ENV_ERROR_CODES)

const canonicalBase64 = z.string().refine((value) => {
  if (value === "") return true
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return false
  }
  return Buffer.from(value, "base64").toString("base64") === value
}, "Expected canonical base64")

export const SessionEnvErrorBodySchema = z
  .object({
    error: z
      .object({
        code: SessionEnvErrorCodeSchema,
        message: z.string().min(1),
      })
      .strict(),
  })
  .strict()

export const SessionEnvReadFileResponseSchema = z
  .object({
    encoding: z.literal("base64"),
    content: canonicalBase64,
  })
  .strict()

export const SessionEnvExistsResponseSchema = z
  .object({
    exists: z.boolean(),
  })
  .strict()

export const SessionEnvFileStatSchema = z
  .object({
    isFile: z.boolean(),
    isDirectory: z.boolean(),
    isSymbolicLink: z.boolean(),
    size: z.number().finite().nonnegative(),
    mtimeMs: z.number().finite(),
  })
  .strict()

export const SessionEnvReaddirResponseSchema = z.array(z.string())

export const SessionEnvMutationResponseSchema = z
  .object({
    ok: z.literal(true),
  })
  .strict()

const SessionEnvStdoutFrameSchema = z
  .object({
    type: z.literal("stdout"),
    data: canonicalBase64,
  })
  .strict()

const SessionEnvStderrFrameSchema = z
  .object({
    type: z.literal("stderr"),
    data: canonicalBase64,
  })
  .strict()

const SessionEnvErrorFrameSchema = z
  .object({
    type: z.literal("error"),
    error: z.string().min(1),
  })
  .strict()

const SessionEnvExitFrameSchema = z
  .object({
    type: z.literal("exit"),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    timedOut: z.boolean().optional(),
    canceled: z.boolean().optional(),
    escalated: z.boolean().optional(),
  })
  .strict()

export const SessionEnvExecFrameSchema = z.discriminatedUnion("type", [
  SessionEnvStdoutFrameSchema,
  SessionEnvStderrFrameSchema,
  SessionEnvErrorFrameSchema,
  SessionEnvExitFrameSchema,
])

export type SessionEnvErrorBody = z.infer<typeof SessionEnvErrorBodySchema>
export type SessionEnvReadFileResponse = z.infer<typeof SessionEnvReadFileResponseSchema>
export type SessionEnvExistsResponse = z.infer<typeof SessionEnvExistsResponseSchema>
export type SessionEnvFileStat = z.infer<typeof SessionEnvFileStatSchema>
export type SessionEnvExecFrame = z.infer<typeof SessionEnvExecFrameSchema>

export class WorkspaceRuntimeProtocolError extends Error {
  readonly code = "workspace_runtime_protocol_error" as const
  readonly operation: string

  constructor(operation: string, cause?: unknown) {
    super(`workspace-runtime ${operation} returned an invalid response`, { cause })
    this.name = "WorkspaceRuntimeProtocolError"
    this.operation = operation
  }
}

function decode<T>(operation: string, schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new WorkspaceRuntimeProtocolError(operation, parsed.error)
  return parsed.data
}

export function decodeSessionEnvErrorBody(input: unknown) {
  return decode("error", SessionEnvErrorBodySchema, input)
}

export function decodeSessionEnvReadFileResponse(input: unknown) {
  return decode("readFile", SessionEnvReadFileResponseSchema, input)
}

export function decodeSessionEnvExistsResponse(input: unknown) {
  return decode("exists", SessionEnvExistsResponseSchema, input)
}

export function decodeSessionEnvStatResponse(input: unknown) {
  return decode("stat", SessionEnvFileStatSchema, input)
}

export function decodeSessionEnvReaddirResponse(input: unknown) {
  return decode("readdir", SessionEnvReaddirResponseSchema, input)
}

export function decodeSessionEnvMutationResponse(operation: string, input: unknown) {
  return decode(operation, SessionEnvMutationResponseSchema, input)
}

export function decodeSessionEnvExecFrame(input: unknown) {
  return decode("exec frame", SessionEnvExecFrameSchema, input)
}

export function encodeSessionEnvExecFrame(input: SessionEnvExecFrame) {
  const frame = decodeSessionEnvExecFrame(input)
  return new TextEncoder().encode(`${JSON.stringify(frame)}\n`)
}
