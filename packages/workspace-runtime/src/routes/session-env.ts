import { Hono } from "hono"
import fs from "fs"
import path from "path"
import { spawn } from "child_process"
import { assertTarget, resolveWorkspaceCommandPaths, resolveWorkspacePath, WorkspaceTargetError } from "../target"
import { buildSafeEnv } from "../pty/env"
import { boundedJsonBody, errorBody, isRequestBodyTooLarge, requestBodyTooLargeBody } from "./http"
import type { ProcessObserver } from "../managed-processes/process-observer"
import type { RelayHostAuthContext } from "../workspace-host-service-auth"
import { denyWorkspaceViewers } from "./workspace-role"
import {
  encodeSessionEnvExecFrame,
  SESSION_ENV_EXEC_DEFAULT_TIMEOUT_MS,
  SESSION_ENV_EXEC_MAX_TIMEOUT_MS,
  type SessionEnvErrorCode,
  type SessionEnvExecFrame,
} from "../session-env-contract"

const EXEC_KILL_GRACE_MS = 250

type ReqCtx = {
  req: {
    query: (k: string) => string | undefined
    header: (k: string) => string | undefined
  }
}

function root(c: ReqCtx) {
  return assertTarget(c.req.query("directory") || c.req.header("x-opencode-directory"))
}

function posix(input: string) {
  return input.split(path.sep).join("/")
}

async function verifiedPath(base: string, input?: string, mustExist = true) {
  const full = await resolveWorkspacePath(base, input)
  if (mustExist) await fs.promises.access(full)
  return full
}

function err(c: { json: (body: unknown, status?: number) => Response }, cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause)
  if (isRequestBodyTooLarge(cause)) {
    return c.json(requestBodyTooLargeBody(), 413)
  }
  if (cause instanceof WorkspaceTargetError && message.includes("pinned")) {
    return c.json(
      sessionEnvErrorBody("session_env_invalid_directory", "Session env directory must match configured workspace"),
      400,
    )
  }
  if (cause instanceof WorkspaceTargetError) {
    return c.json(sessionEnvErrorBody("session_env_path_forbidden", message), 403)
  }
  return c.json(sessionEnvErrorBody("session_env_operation_failed", message), 400)
}

function sessionEnvErrorBody(code: SessionEnvErrorCode, message: string) {
  return errorBody(code, message)
}

function jsonBody(c: { req: { header(name: string): string | undefined; raw: Request } }) {
  return boundedJsonBody<Record<string, unknown>>(c, {})
}

function stringValue(input: unknown) {
  return typeof input === "string" ? input : undefined
}

function numberValue(input: unknown) {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined
}

function boolValue(input: unknown) {
  return typeof input === "boolean" ? input : undefined
}

function envValue(input: unknown) {
  if (!input || typeof input !== "object") return {}
  return Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
}

function mode(input: unknown) {
  if (input === "write") return fs.constants.W_OK
  if (input === "readwrite") return fs.constants.R_OK | fs.constants.W_OK
  return fs.constants.R_OK
}

const ignoreNames = new Set([".git", "node_modules"])
export const SESSION_ENV_GREP_MAX_PATTERN_LENGTH = 256
export const SESSION_ENV_GREP_MAX_FILE_BYTES = 1024 * 1024
export const SESSION_ENV_GREP_MAX_LINE_LENGTH = 64 * 1024

function globRegex(pattern: string) {
  const raw = posix(pattern)
  let out = ""
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (ch === "*" && raw[i + 1] === "*" && raw[i + 2] === "/") {
      out += "(?:.*/)?"
      i += 2
      continue
    }
    if (ch === "*" && raw[i + 1] === "*") {
      out += ".*"
      i++
      continue
    }
    if (ch === "*") {
      out += "[^/]*"
      continue
    }
    if (ch === "?") {
      out += "[^/]"
      continue
    }
    out += /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch
  }
  return new RegExp(`^${out}$`)
}

function ignored(rel: string, ignore: string[]) {
  const text = posix(rel)
  if (text.split("/").some((part) => ignoreNames.has(part))) return true
  return ignore.some((pattern) => globRegex(pattern).test(text))
}

function unsafeRegex() {
  return sessionEnvErrorBody("session_env_unsafe_regex", "Unsafe grep pattern")
}

function grepMatcher(pattern: string, literal: boolean | undefined, ignoreCase: boolean | undefined) {
  if (literal) {
    const needle = ignoreCase ? pattern.toLowerCase() : pattern
    return {
      safe: true as const,
      match: (line: string) => (ignoreCase ? line.toLowerCase() : line).includes(needle),
    }
  }
  if (!safeRegex(pattern)) return { safe: false as const }
  const re = new RegExp(pattern, ignoreCase ? "i" : "")
  return {
    safe: true as const,
    match: (line: string) => re.test(line),
  }
}

function safeRegex(pattern: string) {
  if (pattern.length > SESSION_ENV_GREP_MAX_PATTERN_LENGTH) return false
  if (/\\[1-9]/.test(pattern)) return false
  if (/\(\?[=!<]/.test(pattern)) return false
  try {
    new RegExp(pattern)
  } catch {
    return false
  }
  return !hasNestedOrAmbiguousQuantifier(pattern)
}

function hasNestedOrAmbiguousQuantifier(pattern: string) {
  const groups: Array<{ quantified: boolean; alternation: boolean }> = []
  let escaped = false
  let charClass = false
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === "\\") {
      escaped = true
      continue
    }
    if (charClass) {
      if (ch === "]") charClass = false
      continue
    }
    if (ch === "[") {
      charClass = true
      continue
    }
    if (ch === "(") {
      groups.push({ quantified: false, alternation: false })
      continue
    }
    if (ch === "|") {
      const group = groups.at(-1)
      if (group) group.alternation = true
      continue
    }
    if (isRegexQuantifierStart(ch)) {
      const group = groups.at(-1)
      if (group) group.quantified = true
      if (ch === "{") i = pattern.indexOf("}", i)
      if (i < 0) return true
      continue
    }
    if (ch === ")") {
      const group = groups.pop()
      if (!group) continue
      const next = pattern[i + 1]
      if (next && isRegexQuantifierStart(next) && (group.quantified || group.alternation)) return true
    }
  }
  return false
}

function isRegexQuantifierStart(ch: string) {
  return ch === "*" || ch === "+" || ch === "?" || ch === "{"
}

async function walkFiles(base: string, limit: number, ignore: string[]) {
  const out: string[] = []
  const queue = [base]
  while (queue.length && out.length < limit) {
    const dir = queue.shift()!
    let rows: fs.Dirent[]
    try {
      rows = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const row of rows) {
      const full = path.join(dir, row.name)
      const rel = path.relative(base, full)
      if (ignored(rel, ignore)) continue
      if (row.isDirectory()) {
        queue.push(full)
        continue
      }
      if (row.isFile()) out.push(full)
      if (out.length >= limit) break
    }
  }
  return out
}

/**
 * Enqueue one NDJSON frame on the exec stream controller. Returns `false` when
 * the enqueue fails — the controller is closed/errored (e.g. after the response
 * stream was canceled and a late child-process chunk arrives). Callers MUST
 * treat `false` as "stream is gone" and stop writing; an unguarded enqueue on a
 * canceled stream throws, and in the sandbox host (`{ signals: true }`) that
 * rejection is fatal (drains to `process.exit(1)`). This is the single point
 * where an enqueue may fail, so the `try/catch` is localized here.
 */
function writeNdjson(ctrl: ReadableStreamDefaultController<Uint8Array>, payload: SessionEnvExecFrame) {
  try {
    ctrl.enqueue(encodeSessionEnvExecFrame(payload))
    return true
  } catch {
    return false
  }
}

function signalProcessGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals) {
  if (!child.pid) return
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {}
  }
  try {
    child.kill(signal)
  } catch {}
}

function terminateExec(
  child: ReturnType<typeof spawn>,
  state: {
    reason: "timeout" | "cancel" | undefined
    sigkillTimer: ReturnType<typeof setTimeout> | undefined
    sigkillSent: boolean
  },
  reason: "timeout" | "cancel",
) {
  if (state.reason) return
  state.reason = reason
  signalProcessGroup(child, "SIGTERM")
  state.sigkillTimer = setTimeout(() => {
    state.sigkillSent = true
    signalProcessGroup(child, "SIGKILL")
  }, EXEC_KILL_GRACE_MS)
}

export function SessionEnvRoutes(processObserver?: ProcessObserver) {
  return new Hono<{ Variables: RelayHostAuthContext }>()
    .onError((cause, c) => {
      if (isRequestBodyTooLarge(cause)) return c.json(requestBodyTooLargeBody(), 413)
      throw cause
    })
    .post("/exec", denyWorkspaceViewers("Workspace role does not allow shell execution"), async (c) => {
      const base = root(c)
      const body = await jsonBody(c)
      const command = stringValue(body.command)
      if (!command) return c.json(sessionEnvErrorBody("session_env_command_required", "Missing command"), 400)
      let cwd: string
      try {
        cwd = await verifiedPath(base, stringValue(body.cwd), true)
        await resolveWorkspaceCommandPaths(base, { command, allowAbsoluteExecutable: true })
      } catch (cause) {
        return err(c, cause)
      }
      const child = spawn(command, {
        cwd,
        shell: true,
        detached: process.platform !== "win32",
        env: {
          ...buildSafeEnv(process.env, { customPrefix: "CLAXEDO" }),
          // Request-supplied env: explicit (see SafeEnvSource).
          ...buildSafeEnv(envValue(body.env), { customPrefix: "CLAXEDO", source: "explicit" }),
        },
        stdio: ["ignore", "pipe", "pipe"],
      })
      const owner =
        child.pid && processObserver
          ? processObserver.register(
              {
                ownerId: `session-shell:${crypto.randomUUID()}`,
                ownerGeneration: crypto.randomUUID(),
                launchId: crypto.randomUUID(),
                kind: "session-shell",
                role: "session-shell",
                label: "Session tool shell",
                pid: child.pid,
                workspaceId: c.req.header("x-workspace-id") ?? base,
                directory: cwd,
                ...(stringValue(body.sessionId) ? { sessionId: stringValue(body.sessionId)! } : {}),
                ...(stringValue(body.sessionId) ? { parentOwnerId: `pi-session:${stringValue(body.sessionId)!}` } : {}),
              },
              {
                stopGracefully: async () => signalProcessGroup(child, "SIGTERM"),
                killOwnedTree: async () => signalProcessGroup(child, "SIGKILL"),
              },
            )
          : undefined
      const termination = {
        reason: undefined as "timeout" | "cancel" | undefined,
        sigkillTimer: undefined as ReturnType<typeof setTimeout> | undefined,
        sigkillSent: false,
      }
      const timeout = sessionEnvExecTimeout(body.timeout)
      const timer = setTimeout(() => terminateExec(child, termination, "timeout"), timeout)
      let streamClosed = false
      const stream = new ReadableStream<Uint8Array>({
        start(ctrl) {
          child.stdout?.on("data", (chunk: Buffer) => {
            if (streamClosed) return
            if (!writeNdjson(ctrl, { type: "stdout", data: chunk.toString("base64") })) streamClosed = true
          })
          child.stderr?.on("data", (chunk: Buffer) => {
            if (streamClosed) return
            if (!writeNdjson(ctrl, { type: "stderr", data: chunk.toString("base64") })) streamClosed = true
          })
          child.on("error", (cause) => {
            clearTimeout(timer)
            owner?.exit({ reason: "error" })
            if (streamClosed) return
            streamClosed = true
            writeNdjson(ctrl, { type: "error", error: cause.message })
            ctrl.close()
          })
          child.on("close", (exitCode, signal) => {
            clearTimeout(timer)
            if (!termination.reason && termination.sigkillTimer) clearTimeout(termination.sigkillTimer)
            owner?.exit({
              reason:
                termination.reason === "timeout" ? "timeout" : termination.reason === "cancel" ? "cancelled" : "exited",
              ...(typeof exitCode === "number" ? { exitCode } : {}),
            })
            if (streamClosed) return
            streamClosed = true
            writeNdjson(ctrl, {
              type: "exit",
              exitCode,
              signal,
              timedOut: termination.reason === "timeout",
              canceled: termination.reason === "cancel",
              escalated: termination.sigkillSent || signal === "SIGKILL",
            })
            ctrl.close()
          })
        },
        cancel() {
          streamClosed = true
          clearTimeout(timer)
          terminateExec(child, termination, "cancel")
        },
      })
      return new Response(stream, {
        headers: {
          "Content-Type": "application/x-ndjson",
          "Cache-Control": "no-cache",
          "X-Content-Type-Options": "nosniff",
        },
      })
    })
    .get("/file/read", async (c) => {
      try {
        const full = await verifiedPath(root(c), c.req.query("path"), true)
        return c.json({
          encoding: "base64",
          content: (await fs.promises.readFile(full)).toString("base64"),
        })
      } catch (cause) {
        return err(c, cause)
      }
    })
    .post("/file/write", async (c) => {
      try {
        const base = root(c)
        const body = await jsonBody(c)
        const full = await verifiedPath(base, stringValue(body.path), false)
        const content = stringValue(body.content) ?? ""
        await fs.promises.mkdir(path.dirname(full), { recursive: true })
        await fs.promises.writeFile(full, body.encoding === "base64" ? Buffer.from(content, "base64") : content)
        return c.json({ ok: true })
      } catch (cause) {
        return err(c, cause)
      }
    })
    .post("/file/access", async (c) => {
      try {
        const body = await jsonBody(c)
        await fs.promises.access(await verifiedPath(root(c), stringValue(body.path), true), mode(body.mode))
        return c.json({ ok: true })
      } catch (cause) {
        return err(c, cause)
      }
    })
    .get("/file/exists", async (c) => {
      try {
        await fs.promises.access(await verifiedPath(root(c), c.req.query("path"), true))
        return c.json({ exists: true })
      } catch {
        return c.json({ exists: false })
      }
    })
    .get("/file/stat", async (c) => {
      try {
        const stat = await fs.promises.stat(await verifiedPath(root(c), c.req.query("path"), true))
        return c.json({
          isFile: stat.isFile(),
          isDirectory: stat.isDirectory(),
          isSymbolicLink: stat.isSymbolicLink(),
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        })
      } catch (cause) {
        return err(c, cause)
      }
    })
    .get("/file/readdir", async (c) => {
      try {
        const full = await verifiedPath(root(c), c.req.query("path"), true)
        return c.json(await fs.promises.readdir(full))
      } catch (cause) {
        return err(c, cause)
      }
    })
    .post("/file/mkdir", async (c) => {
      try {
        const body = await jsonBody(c)
        await fs.promises.mkdir(await verifiedPath(root(c), stringValue(body.path), false), {
          recursive: boolValue(body.recursive) ?? true,
        })
        return c.json({ ok: true })
      } catch (cause) {
        return err(c, cause)
      }
    })
    .post("/file/rm", async (c) => {
      try {
        const body = await jsonBody(c)
        await fs.promises.rm(await verifiedPath(root(c), stringValue(body.path), true), {
          recursive: boolValue(body.recursive) ?? false,
          force: boolValue(body.force) ?? false,
        })
        return c.json({ ok: true })
      } catch (cause) {
        return err(c, cause)
      }
    })
    .post("/glob", async (c) => {
      try {
        const base = root(c)
        const body = await jsonBody(c)
        const pattern = stringValue(body.pattern)
        if (!pattern) return c.json(sessionEnvErrorBody("session_env_pattern_required", "Missing pattern"), 400)
        const cwd = await verifiedPath(base, stringValue(body.cwd), true)
        const limit = Math.min(Math.max(numberValue(body.limit) ?? 1000, 1), 10_000)
        const ignore = Array.isArray(body.ignore)
          ? body.ignore.filter((item): item is string => typeof item === "string")
          : []
        const re = globRegex(pattern)
        const files = (await walkFiles(cwd, limit, ignore))
          .map((item) => path.relative(cwd, item))
          .filter((item) => re.test(posix(item)))
          .slice(0, limit)
        return c.json({ paths: files })
      } catch (cause) {
        return err(c, cause)
      }
    })
    .post("/grep", async (c) => {
      try {
        const base = root(c)
        const body = await jsonBody(c)
        const pattern = stringValue(body.pattern)
        if (!pattern) return c.json(sessionEnvErrorBody("session_env_pattern_required", "Missing pattern"), 400)
        const searchPath = await verifiedPath(base, stringValue(body.path), true)
        const stat = await fs.promises.stat(searchPath)
        const limit = Math.min(Math.max(numberValue(body.limit) ?? 100, 1), 10_000)
        const matcher = grepMatcher(pattern, boolValue(body.literal), boolValue(body.ignoreCase))
        if (!matcher.safe) return c.json(unsafeRegex(), 400)
        const glob = stringValue(body.glob)
        const globMatch = glob ? globRegex(glob) : undefined
        const context = Math.min(Math.max(numberValue(body.context) ?? 0, 0), 20)
        const files = stat.isDirectory() ? await walkFiles(searchPath, 50_000, []) : [searchPath]
        const matches: Array<{ path: string; line: number; text: string; before: string[]; after: string[] }> = []
        let skippedFiles = 0
        for (const file of files) {
          const rel = stat.isDirectory() ? path.relative(searchPath, file) : path.basename(file)
          if (globMatch && !globMatch.test(posix(rel))) continue
          const fileStat = await fs.promises.stat(file).catch(() => undefined)
          if (!fileStat || fileStat.size > SESSION_ENV_GREP_MAX_FILE_BYTES) {
            skippedFiles++
            continue
          }
          let text: string
          try {
            text = await fs.promises.readFile(file, "utf-8")
          } catch {
            continue
          }
          const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].length > SESSION_ENV_GREP_MAX_LINE_LENGTH) continue
            if (!matcher.match(lines[i])) continue
            matches.push({
              path: rel,
              line: i + 1,
              text: lines[i],
              before: context > 0 ? lines.slice(Math.max(0, i - context), i) : [],
              after: context > 0 ? lines.slice(i + 1, Math.min(lines.length, i + 1 + context)) : [],
            })
            if (matches.length >= limit) return c.json({ matches, limitReached: true, skippedFiles })
          }
        }
        return c.json({ matches, limitReached: false, skippedFiles })
      } catch (cause) {
        return err(c, cause)
      }
    })
}

export function sessionEnvExecTimeout(input: unknown) {
  const requested = numberValue(input)
  return requested && requested > 0
    ? Math.min(requested, SESSION_ENV_EXEC_MAX_TIMEOUT_MS)
    : SESSION_ENV_EXEC_DEFAULT_TIMEOUT_MS
}
