import type { Context } from "@earendil-works/chord"
import { ExecutionError, FileError, type ExecutionEnv, type FileErrorCode, type FileInfo, type Result, type ShellExecOptions,
  type ShellExecResult, type TextLineReader } from "@earendil-works/pi-durable/env"
import type { TurnExecutionAccess } from "@claxedo/harness/contract"
import { asNumber, asRecord, asString } from "@claxedo/helpers/guards"
import { serverSentEvents } from "./server-sent-events"

type WireError = { code: string; message: string; path?: string }
type WireResult = { ok: true; value?: unknown } | { ok: false; error: WireError }
type Read<T> = (value: unknown) => T

const FILE_ERROR_CODES: readonly FileErrorCode[] = ["aborted", "not_found", "permission_denied", "not_directory", "is_directory", "invalid", "not_supported", "unknown"]
const EXECUTION_ERROR_CODES: readonly ExecutionError["code"][] = ["aborted", "timeout", "shell_unavailable", "spawn_error", "callback_error", "unknown"]

function base64(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function invalidAnswer(what: string): never {
  throw new Error(`The workspace machine answered an invalid ${what}`)
}

const answerText: Read<string> = (value) => typeof value === "string" ? value : invalidAnswer("path or text")
const answerFlag: Read<boolean> = (value) => typeof value === "boolean" ? value : invalidAnswer("answer")
const answerNone: Read<void> = () => undefined
const answerLines: Read<string[]> = (value) => Array.isArray(value) ? value.map(answerText) : invalidAnswer("line list")

const answerBytes: Read<Uint8Array> = (value) => {
  const encoded = asString(asRecord(value)?.base64) ?? invalidAnswer("binary content")
  return Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0))
}

const answerInfo: Read<FileInfo> = (value) => {
  const row = asRecord(value)
  const kind = row?.kind === "file" || row?.kind === "directory" || row?.kind === "symlink" ? row.kind : invalidAnswer("file kind")
  return { name: answerText(row?.name), path: answerText(row?.path), kind, size: asNumber(row?.size) ?? invalidAnswer("file size"), mtimeMs: asNumber(row?.mtimeMs) ?? invalidAnswer("file time") }
}

const answerInfos: Read<FileInfo[]> = (value) => Array.isArray(value) ? value.map(answerInfo) : invalidAnswer("directory listing")

function wireResult(value: unknown): WireResult {
  const row = asRecord(value) ?? invalidAnswer("result")
  if (row.ok === true) return { ok: true, value: row.value }
  const error = asRecord(row.error)
  const path = asString(error?.path)
  return { ok: false, error: { code: asString(error?.code) ?? "unknown", message: asString(error?.message) ?? "", ...(path ? { path } : {}) } }
}

function content(value: string | Uint8Array) {
  return typeof value === "string" ? value : { base64: base64(value) }
}

function fileError(error: WireError): FileError {
  const code = FILE_ERROR_CODES.find((known) => known === error.code) ?? "unknown"
  return new FileError(code, error.message, error.path)
}

/** One text file served one line at a time; the machine refuses a file over its read limit as `invalid`. */
function lineReader(text: string): TextLineReader {
  const lines = text.split("\n")
  if (lines.at(-1) === "") lines.pop()
  let index = 0
  return {
    readLine: async () => {
      if (index >= lines.length) return { ok: true, value: undefined }
      const line = lines[index]
      index += 1
      return { ok: true, value: { text: line, terminated: index < lines.length || text.endsWith("\n") } }
    },
    close: async () => {},
  }
}

/**
 * Pi's execution environment on the workspace machine: every file operation
 * and command goes through the relay to the machine's `execution-env` routes
 * with the turn's session-scoped token. Its files are the machine's, so its
 * namespace is the workspace's own.
 */
export class RemoteExecutionEnv implements ExecutionEnv {
  readonly id: string
  cwd: string

  constructor(private readonly access: TurnExecutionAccess) {
    this.id = `vm:${access.workspaceId}`
    this.cwd = access.directory
  }

  private route(path: string): string {
    return `${this.access.relayUrl}/workspaces/${encodeURIComponent(this.access.workspaceId)}/api/wr/execution-env/${path}`
  }

  private async request(path: string, body: unknown, context: Context): Promise<Response> {
    return fetch(this.route(path), {
      method: "POST",
      headers: { authorization: `Bearer ${this.access.runtimeAccessToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(context.abortSignal ? { signal: context.abortSignal } : {}),
    })
  }

  private async fs<T>(op: string, args: unknown[], context: Context, read: Read<T>): Promise<Result<T, FileError>> {
    try {
      const response = await this.request("fs", { op, args }, context)
      if (response.status === 400) return { ok: false, error: new FileError("invalid", await response.text()) }
      if (!response.ok) return { ok: false, error: new FileError("unknown", `The workspace machine answered ${response.status}: ${await response.text()}`) }
      const result = wireResult(await response.json())
      return result.ok ? { ok: true, value: read(result.value) } : { ok: false, error: fileError(result.error) }
    } catch (error) {
      return { ok: false, error: new FileError(context.abortSignal?.aborted ? "aborted" : "unknown", String(error)) }
    }
  }

  absolutePath(path: string, context: Context) { return this.fs("absolutePath", [path], context, answerText) }
  joinPath(parts: string[], context: Context) { return this.fs("joinPath", [parts], context, answerText) }
  readTextFile(path: string, context: Context) { return this.fs("readTextFile", [path], context, answerText) }
  readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context) {
    return this.fs("readTextLines", [path, options ?? null], context, answerLines)
  }
  readBinaryFile(path: string, context: Context) { return this.fs("readBinaryFile", [path], context, answerBytes) }
  writeFile(path: string, data: string | Uint8Array, context: Context) { return this.fs("writeFile", [path, content(data)], context, answerNone) }
  appendFile(path: string, data: string | Uint8Array, context: Context) { return this.fs("appendFile", [path, content(data)], context, answerNone) }
  truncateFile(path: string, size: number, context: Context) { return this.fs("truncateFile", [path, size], context, answerNone) }
  flushFile(path: string, context: Context) { return this.fs("flushFile", [path], context, answerNone) }
  renameFile(source: string, destination: string, context: Context) { return this.fs("renameFile", [source, destination], context, answerNone) }
  fileInfo(path: string, context: Context) { return this.fs("fileInfo", [path], context, answerInfo) }
  listDir(path: string, context: Context) { return this.fs("listDir", [path], context, answerInfos) }
  canonicalPath(path: string, context: Context) { return this.fs("canonicalPath", [path], context, answerText) }
  exists(path: string, context: Context) { return this.fs("exists", [path], context, answerFlag) }
  createDir(path: string, options: { recursive?: boolean } | undefined, context: Context) {
    return this.fs("createDir", [path, options ?? null], context, answerNone)
  }
  remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context) {
    return this.fs("remove", [path, options ?? null], context, answerNone)
  }
  createTempDir(prefix: string | undefined, context: Context) { return this.fs("createTempDir", [prefix ?? null], context, answerText) }
  createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context) {
    return this.fs("createTempFile", [options ?? null], context, answerText)
  }

  async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
    const text = await this.readTextFile(path, context)
    return text.ok ? { ok: true, value: lineReader(text.value) } : text
  }

  async cleanup(): Promise<void> {}

  async exec(command: string, options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
    const { onOutput, ...wire } = options ?? {}
    try {
      const response = await this.request("exec", { command, ...wire }, context)
      if (!response.ok || !response.body) {
        return { ok: false, error: new ExecutionError("unknown", `The workspace machine answered ${response.status}: ${await response.text()}`) }
      }
      for await (const event of serverSentEvents(response.body)) {
        if (event.name === "output") onOutput?.(answerText(asRecord(JSON.parse(event.data))?.text), context)
        if (event.name === "result") return execResult(wireResult(JSON.parse(event.data)))
      }
      return { ok: false, error: new ExecutionError("unknown", "The workspace machine ended the command without a result") }
    } catch (error) {
      return { ok: false, error: new ExecutionError(context.abortSignal?.aborted ? "aborted" : "unknown", String(error)) }
    }
  }
}

function execResult(result: WireResult): Result<ShellExecResult, ExecutionError> {
  if (result.ok) {
    const value = asRecord(result.value)
    const spillPath = asString(value?.spillPath)
    return { ok: true, value: { exitCode: asNumber(value?.exitCode) ?? invalidAnswer("exit code"), ...(spillPath ? { spillPath } : {}) } }
  }
  const code = EXECUTION_ERROR_CODES.find((known) => known === result.error.code) ?? "unknown"
  return { ok: false, error: new ExecutionError(code, result.error.message) }
}
