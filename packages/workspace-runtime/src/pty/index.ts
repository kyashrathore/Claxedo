/**
 * PTY Module (claxedo-server standalone)
 *
 * Adapted from packages/claxedo-app/src/opencode-patches/pty/index.ts.
 * Removes opencode-specific abstractions (Instance, Bus, Shell, Plugin, Identifier)
 * and uses claxedoBus directly.
 */

import { type IPty } from "node-pty"
import z from "zod"
import { Log } from "../log"
import type { WSContext } from "hono/ws"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { getTerminalEnvVars, isSetupComplete, setupAgentHooks } from "../agent-hooks"
import { createDiskHistory, renameHistory } from "./history-disk"
import { containsClearScrollbackSequence, extractContentAfterClear } from "./escape-filter"
import { osc7 as osc7Parser } from "./osc7"
import { oscProcessExit } from "./osc-process-exit"
import { buildSafeEnv, getLocale } from "./env"
import { resolveCwd } from "./resolve-cwd"
import { disposeMode } from "./dispose-mode"
import {
  type QueuedOperation,
  type WriteQueueSession,
  operationBytes,
  enqueueWrite,
  flushWriteQueue,
} from "./write-queue"
import { decodeInput } from "./decode-input"
import { claxedoBus, type PtyInfo } from "../bus"
import { ensureSpawnHelper } from "./spawn-helper-fix"

// Lazy PTY spawn
let _ptySpawn: typeof import("node-pty")["spawn"] | undefined
async function getSpawn() {
  if (!_ptySpawn) {
    await ensureSpawnHelper()
    const pty = await import("node-pty")
    _ptySpawn = pty.spawn
  }
  return _ptySpawn
}

// Lazy agent hooks setup
const setupLog = Log.create({ service: "pty-setup" })
const setup = { promise: undefined as Promise<void> | undefined }

async function ensureSetup(port: number) {
  if (isSetupComplete()) return true
  if (!setup.promise) {
    setup.promise = setupAgentHooks({ port })
      .catch((err) => {
        setupLog.error("Agent hooks setup failed", { err })
        return undefined
      })
      .finally(() => {
        setup.promise = undefined
      })
  }
  await setup.promise
  return isSetupComplete()
}

export namespace Pty {
  const log = Log.create({ service: "pty" })

  const BUFFER_LIMIT = 1024 * 1024 * 2
  const HISTORY_LIMIT = (() => {
    const raw = Number(process.env.OPENCODE_PTY_HISTORY_LIMIT)
    if (!Number.isFinite(raw) || raw <= 0) return 1024 * 1024 * 16
    return Math.floor(raw)
  })()
  const BUFFER_CHUNK = 64 * 1024
  const QUEUE_HIGH_WATERMARK = (() => {
    const raw = Number(process.env.OPENCODE_PTY_QUEUE_HIGH_WATERMARK)
    if (!Number.isFinite(raw) || raw <= 0) return 1024 * 1024
    return Math.floor(raw)
  })()
  const QUEUE_LOW_WATERMARK = (() => {
    const raw = Number(process.env.OPENCODE_PTY_QUEUE_LOW_WATERMARK)
    if (!Number.isFinite(raw) || raw <= 0) return 256 * 1024
    return Math.floor(raw)
  })()
  const DEBUG = process.env.OPENCODE_PTY_DEBUG === "1"
  const DEBUG_RESIZE = process.env.OPENCODE_DEBUG_PTY_RESIZE === "1"
  const CLAXEDO_DEBUG = process.env.CLAXEDO_DEBUG === "1"
  const ORPHAN_TIMEOUT_MS = (() => {
    const raw = Number(process.env.OPENCODE_PTY_ORPHAN_TIMEOUT_MS)
    if (!Number.isFinite(raw) || raw <= 0) return 60_000
    return Math.floor(raw)
  })()
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const sample = (value: string) =>
    value
      .replaceAll("\r", "\\r")
      .replaceAll("\n", "\\n")
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "<esc>")
      .slice(0, 80)

  const meta = (cursor: number) => {
    const json = JSON.stringify({ cursor })
    const bytes = encoder.encode(json)
    const out = new Uint8Array(bytes.length + 1)
    out[0] = 0
    out.set(bytes, 1)
    return out
  }

  export const osc7 = osc7Parser

  function safeReplay(ws: WSContext, replay: string) {
    if (!replay) return true
    try {
      for (let i = 0; i < replay.length; i += BUFFER_CHUNK) {
        ws.send(replay.slice(i, i + BUFFER_CHUNK))
      }
      return true
    } catch {
      return false
    }
  }

  function safeBroadcast(session: ActiveSession, data: string) {
    for (const ws of session.subscribers) {
      if (ws.readyState !== 1) {
        session.subscribers.delete(ws)
        continue
      }
      try {
        ws.send(data)
      } catch {
        session.subscribers.delete(ws)
        ws.close()
      }
    }
  }

  function busy(text: string) {
    return (
      text.includes("EADDRINUSE") ||
      /address already in use/i.test(text) ||
      /port\s+\d{2,5}\s+is\s+already\s+in\s+use/i.test(text)
    )
  }

  async function killProcessTree(pid: number) {
    if (!Number.isFinite(pid) || pid <= 0) return
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      if (process.platform !== "win32") {
        try {
          process.kill(-pid, signal)
        } catch {}
      }
      try {
        process.kill(pid, signal)
      } catch {}
      if (signal === "SIGTERM") {
        await new Promise((r) => setTimeout(r, 500))
      }
    }
  }

  export const Info = z.object({
    id: z.string(),
    title: z.string(),
    command: z.string(),
    args: z.array(z.string()),
    cwd: z.string(),
    status: z.enum(["running", "exited"]),
    pid: z.number(),
  })

  export type Info = z.infer<typeof Info>

  export const CreateInput = z.object({
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    title: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    previousPtyId: z.string().optional(),
    managed: z.boolean().optional(),
  })

  export type CreateInput = z.infer<typeof CreateInput>

  export const UpdateInput = z.object({
    title: z.string().optional(),
    size: z
      .object({
        rows: z.number(),
        cols: z.number(),
      })
      .optional(),
  })

  export type UpdateInput = z.infer<typeof UpdateInput>

  export const Event = {
    Created: { type: "pty.created" as const },
    Updated: { type: "pty.updated" as const },
    Exited: { type: "pty.exited" as const },
    Deleted: { type: "pty.deleted" as const },
    Stream: { type: "pty.stream" as const },
  }

  interface ActiveSession {
    info: Info
    process: IPty
    buffer: string
    bufferCursor: number
    cursor: number
    history: Awaited<ReturnType<typeof createDiskHistory>>
    osc7: string
    processExitBuf: string
    subscribers: Set<WSContext>
    exited: boolean
    removed: boolean
    ready: boolean
    writeQueue: QueuedOperation[]
    queuedBytes: number
    highWatermark: number
    lowWatermark: number
    createdAt: number
    firstByteAt: number | undefined
    directory: string
    managed: boolean
    addrInUse: boolean
    orphanTimer: ReturnType<typeof setTimeout> | undefined
    interruptTimer: ReturnType<typeof setTimeout> | undefined
  }

  function clearInterrupt(session: ActiveSession) {
    if (!session.interruptTimer) return
    clearTimeout(session.interruptTimer)
    session.interruptTimer = undefined
  }

  function interrupt(id: string, session: ActiveSession) {
    if (!session.managed) return
    if (session.interruptTimer) return
    session.interruptTimer = setTimeout(() => {
      session.interruptTimer = undefined
      if (session.exited || session.removed || session.info.status !== "running") return
      claxedoBus.publish({ type: "pty.stream", id, kind: "command-exit", exitCode: 130 })
    }, 150)
  }

  async function cleanupSession(id: string, session: ActiveSession, reason: "exit" | "remove") {
    if (session.removed) return

    clearInterrupt(session)

    if (session.orphanTimer) {
      clearTimeout(session.orphanTimer)
      session.orphanTimer = undefined
    }

    if (reason === "exit") {
      await session.history.close()

      for (const ws of session.subscribers) {
        ws.close()
      }
      session.subscribers.clear()

      setTimeout(() => {
        if (sessions.get(id) === session) {
          for (const ws of session.subscribers) {
            ws.close()
          }
          session.subscribers.clear()
          sessions.delete(id)
          session.removed = true
          if (DEBUG) log.info("garbage collected exited session", { id })
        }
      }, 1000 * 60)
      return
    }

    session.removed = true
    session.ready = false
    for (const ws of session.subscribers) {
      ws.close()
    }
    session.subscribers.clear()
    session.writeQueue = []
    session.queuedBytes = 0
    try {
      await killProcessTree(session.info.pid)
    } catch {}
    await session.history.close()
    sessions.delete(id)
  }

  const sessions = new Map<string, ActiveSession>()

  export function list() {
    return Array.from(sessions.values()).map((s) => s.info)
  }

  export function listDetailed() {
    return Array.from(sessions.values()).map((s) => ({
      ...s.info,
      subscribers: s.subscribers.size,
      ready: s.ready,
      exited: s.exited,
      removed: s.removed,
      managed: s.managed,
      orphanTimerActive: !!s.orphanTimer,
    }))
  }

  export function get(id: string) {
    return sessions.get(id)?.info
  }

  export function hasAddrInUse(id: string) {
    return sessions.get(id)?.addrInUse ?? false
  }

  export function snapshot(id: string, max = BUFFER_LIMIT) {
    const session = sessions.get(id)
    if (!session) return ""
    const cap = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : BUFFER_LIMIT
    if (cap <= 0) return ""
    if (session.buffer.length <= cap) return session.buffer
    return session.buffer.slice(-cap)
  }

  export async function create(input: CreateInput) {
    const createStart = performance.now()
    const id = "pty_" + crypto.randomUUID().replace(/-/g, "")
    const command =
      input.command ||
      process.env.SHELL ||
      ((() => {
        try {
          return os.userInfo().shell
        } catch {
          return null
        }
      })()) ||
      "/bin/sh"
    const args = input.args || []
    const shellName = command.split("/").pop() || ""
    if (/^(ba|da|k|c|z|tc|fi)?sh$/.test(shellName)) {
      args.push("-l")
    }

    const cwd = resolveCwd(input.cwd, undefined)

    try {
      await fs.promises.mkdir(cwd, { recursive: true })
    } catch (err) {
      log.warn("failed to create cwd", { cwd, err })
    }

    const t0 = performance.now()
    const shellEnv = { env: {} }
    const shellEnvMs = performance.now() - t0

    const { previousPtyId: _prevPty, ...inputEnv } = input.env || {}
    const env = {
      ...buildSafeEnv(process.env, { customPrefix: "CLAXEDO" }),
      ...inputEnv,
      ...shellEnv.env,
      TERM: "xterm-256color",
      OPENCODE_TERMINAL: "1",
      COLORFGBG: "15;0",
    } as Record<string, string>
    if (DEBUG_RESIZE) {
      log.info("pty create env", {
        id,
        cwd,
        shell: command,
        term: env.TERM,
        columns: env.COLUMNS,
        lines: env.LINES,
      })
    }

    const claxedoPort = env.CLAXEDO_PORT
    const port = claxedoPort ? parseInt(claxedoPort, 10) || 7860 : 0

    const t1 = performance.now()
    const setupComplete = claxedoPort ? await ensureSetup(port) : false
    const ensureSetupMs = performance.now() - t1

    if (CLAXEDO_DEBUG && claxedoPort) {
      log.info("Agent hooks check", {
        CLAXEDO_PORT: claxedoPort,
        isSetupComplete: setupComplete,
        command,
        id,
      })
    }

    if (claxedoPort && setupComplete) {
      const tabId = env.CLAXEDO_TAB_ID || id
      const terminalId = env.CLAXEDO_TERMINAL_ID || id
      const workspaceId = env.CLAXEDO_WORKSPACE_ID || cwd

      if (CLAXEDO_DEBUG) {
        log.info("Injecting agent hooks env", { tabId, terminalId, workspaceId, port })
      }

      const agentEnv = getTerminalEnvVars({
        tabId,
        terminalId,
        workspaceId,
        port,
        shell: command,
      })

      if (CLAXEDO_DEBUG) {
        log.info("Agent hooks env vars", agentEnv)
      }

      Object.assign(env, agentEnv)
    } else if (CLAXEDO_DEBUG && claxedoPort && !setupComplete) {
      log.warn("Agent hooks not injected: setup incomplete", {
        CLAXEDO_PORT: claxedoPort,
      })
    }

    const xdgDataDir = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
    const worktreePrefix = path.join(xdgDataDir, "opencode", "worktree") + "/"
    if (cwd.startsWith(worktreePrefix)) {
      env.OPENCODE_WORKTREE = path.basename(cwd)
    }

    if (process.platform === "win32") {
      env.LC_ALL = "C.UTF-8"
      env.LC_CTYPE = "C.UTF-8"
      env.LANG = "C.UTF-8"
    } else if (!env.LANG) {
      env.LANG = getLocale(process.env)
    }
    log.info("creating session", { id, cmd: command, args, cwd })
    if (DEBUG) log.info("create input", input)

    const t2 = performance.now()
    const spawn = await getSpawn()
    const ptyImportMs = performance.now() - t2

    const t3 = performance.now()
    const ptyProcess = spawn(command, args, {
      name: "xterm-256color",
      cwd,
      env,
    })
    const spawnMs = performance.now() - t3

    const info = {
      id,
      title: input.title || `Terminal ${id.slice(-4)}`,
      command,
      args,
      cwd,
      status: "running",
      pid: ptyProcess.pid,
    } as const

    const previousPtyId = input.env?.previousPtyId
    if (previousPtyId) {
      try {
        await renameHistory(cwd, previousPtyId, id)
      } catch (err) {
        log.info("history rename failed", { previousPtyId, id, err: String(err) })
      }
    }

    const t4 = performance.now()
    const history = await createDiskHistory({ directory: cwd, id, limit: HISTORY_LIMIT })
    const diskHistoryMs = performance.now() - t4

    const totalMs = performance.now() - createStart
    log.info("pty.create timing", {
      id,
      totalMs: Math.round(totalMs),
      shellEnvMs: Math.round(shellEnvMs),
      ensureSetupMs: Math.round(ensureSetupMs),
      ptyImportMs: Math.round(ptyImportMs),
      spawnMs: Math.round(spawnMs),
      diskHistoryMs: Math.round(diskHistoryMs),
      setupComplete,
      hasClaxedoPort: !!claxedoPort,
    })

    const restored = previousPtyId ? history.snapshot() : ""

    const session: ActiveSession = {
      info,
      process: ptyProcess,
      buffer: restored,
      bufferCursor: 0,
      cursor: restored.length,
      history,
      osc7: "",
      processExitBuf: "",
      subscribers: new Set(),
      exited: false,
      removed: false,
      ready: false,
      writeQueue: [],
      queuedBytes: 0,
      highWatermark: QUEUE_HIGH_WATERMARK,
      lowWatermark: QUEUE_LOW_WATERMARK,
      createdAt: performance.now(),
      firstByteAt: undefined,
      directory: cwd,
      managed: !!input.managed,
      addrInUse: false,
      orphanTimer: undefined,
      interruptTimer: undefined,
    }
    sessions.set(id, session)
    ptyProcess.onData((data) => {
      if (session.firstByteAt === undefined) {
        session.firstByteAt = performance.now()
        const firstByteMs = session.firstByteAt - session.createdAt
        log.info("pty.firstByte", {
          id,
          firstByteMs: Math.round(firstByteMs),
          bytes: data.length,
        })
      }

      session.cursor += data.length

      const parsed = osc7(session.osc7, data)
      session.osc7 = parsed.buf
      if (parsed.cwd && parsed.cwd !== session.info.cwd) {
        session.info.cwd = parsed.cwd
        if (DEBUG) log.info("cwd updated", { id, cwd: parsed.cwd })
        claxedoBus.publish({ type: "pty.updated", info: session.info })
      }

      const exitParsed = oscProcessExit(session.processExitBuf, data)
      session.processExitBuf = exitParsed.buf
      if (exitParsed.exitCode !== undefined) {
        clearInterrupt(session)
        // Flush stray terminal reply bytes (e.g., CPR \x1b[1;1R) that may have
        // accumulated in the PTY slave input buffer while the command was running
        // but were never consumed before exit. \x15 (Ctrl+U) kills any text that
        // zsh's ZLE accumulated from those bytes, so the prompt comes back clean
        // instead of showing garbage like "1R".
        try { session.process.write("\x15") } catch {}
        claxedoBus.publish({ type: "pty.stream", id, kind: "command-exit", exitCode: exitParsed.exitCode })
      }

      safeBroadcast(session, data)

      session.buffer += data
      if (session.buffer.length > BUFFER_LIMIT) {
        const excess = session.buffer.length - BUFFER_LIMIT
        session.buffer = session.buffer.slice(excess)
        session.bufferCursor += excess
      }
      if (session.managed && busy(data)) {
        session.addrInUse = true
        claxedoBus.publish({ type: "pty.stream", id, kind: "data", tail: snapshot(id, 16_384) })
      }

      const filtered = (() => {
        if (!containsClearScrollbackSequence(data)) return data
        void session.history.clear()
        return extractContentAfterClear(data)
      })()
      if (filtered) session.history.append(filtered)
    })
    ptyProcess.onExit(async ({ exitCode }) => {
      if (session.exited) return
      session.exited = true
      clearInterrupt(session)
      log.info("session exited", { id, exitCode })
      session.info.status = "exited"
      const tail = snapshot(id, 16_384)
      claxedoBus.publish({ type: "pty.exited", id, exitCode, tail })
      claxedoBus.publish({ type: "pty.stream", id, kind: "exit", exitCode, tail })
      await cleanupSession(id, session, "exit")
    })
    claxedoBus.publish({ type: "pty.created", info })
    return info
  }

  export async function update(id: string, input: UpdateInput) {
    const session = sessions.get(id)
    if (!session) return
    if (input.title) {
      session.info.title = input.title
    }
    if (input.size) {
      if (DEBUG_RESIZE) {
        log.info("pty.update size", {
          id,
          cols: input.size.cols,
          rows: input.size.rows,
          ready: session.ready,
          subscribers: session.subscribers.size,
          queueDepth: session.writeQueue.length,
        })
      }
      if (!session.ready) {
        enqueueWrite(session, { type: "resize", cols: input.size.cols, rows: input.size.rows })
      } else {
        session.process.resize(input.size.cols, input.size.rows)
      }
    }
    claxedoBus.publish({ type: "pty.updated", info: session.info })
    return session.info
  }

  export async function remove(id: string) {
    const session = sessions.get(id)
    if (!session) return
    log.info("removing session", { id })
    await cleanupSession(id, session, "remove")
    claxedoBus.publish({ type: "pty.deleted", id })
  }

  export function resize(id: string, cols: number, rows: number) {
    const session = sessions.get(id)
    if (session && session.info.status === "running") {
      if (!session.ready) {
        enqueueWrite(session, { type: "resize", cols, rows })
        return
      }
      session.process.resize(cols, rows)
    }
  }

  export function write(id: string, data: string) {
    const session = sessions.get(id)
    if (session && session.info.status === "running") {
      if (!session.ready) {
        enqueueWrite(session, { type: "write", data })
        return
      }
      if (data.includes("\x03")) {
        interrupt(id, session)
      }
      session.process.write(data)
    }
  }

  export function connect(id: string, ws: WSContext, cursor?: number) {
    const session = sessions.get(id)
    if (!session) {
      ws.close(1008, "Session not found")
      return
    }
    session.subscribers.add(ws)

    if (session.orphanTimer) {
      clearTimeout(session.orphanTimer)
      session.orphanTimer = undefined
      log.info("orphan timer cancelled — client reconnected", { id })
    }

    const start = session.bufferCursor
    const end = session.cursor

    const from =
      cursor === -1 ? end : typeof cursor === "number" && Number.isSafeInteger(cursor) ? Math.max(0, cursor) : 0
    if (DEBUG_RESIZE) {
      log.info("pty.connect cursor", {
        id,
        start,
        end,
        requested: cursor,
        from,
      })
    }

    const data = (() => {
      if (!session.buffer) return ""
      if (from >= end) return ""
      const offset = Math.max(0, from - start)
      if (offset >= session.buffer.length) return ""
      return session.buffer.slice(offset)
    })()

    if (!safeReplay(ws, data)) {
      session.subscribers.delete(ws)
      claxedoBus.publish({ type: "pty.stream", id, kind: "error", message: "replay_send_failed" })
      ws.close()
      return
    }

    try {
      ws.send(meta(end))
    } catch {
      session.subscribers.delete(ws)
      ws.close()
      return
    }

    session.ready = true
    flushWriteQueue(session)

    return {
      onMessage: (message: unknown) => {
        const input = decodeInput(message, decoder)
        if (!input) {
          if (CLAXEDO_DEBUG) log.info("ws input dropped: unsupported payload", { id, type: typeof message })
          return
        }
        if (session.info.status !== "running") {
          if (CLAXEDO_DEBUG) {
            log.info("ws input dropped: session not running", { id, status: session.info.status })
          }
          return
        }
        if (CLAXEDO_DEBUG) {
          log.info("ws input received", {
            id,
            bytes: input.length,
            sample: sample(input),
          })
        }
        if (input.includes("\x03")) {
          interrupt(id, session)
        }
        session.process.write(input)
      },
      onClose: () => {
        log.info("client disconnected from session", { id })
        session.subscribers.delete(ws)
        claxedoBus.publish({ type: "pty.stream", id, kind: "disconnect" })
        if (session.subscribers.size === 0) {
          session.ready = false
          if (!session.managed && !session.exited && !session.removed && !session.orphanTimer) {
            log.info("orphan timer started", { id, timeoutMs: ORPHAN_TIMEOUT_MS })
            session.orphanTimer = setTimeout(() => {
              const current = sessions.get(id)
              if (!current) return
              current.orphanTimer = undefined
              if (current.subscribers.size > 0 || current.exited || current.removed) return
              log.info("orphan timer fired — removing abandoned PTY", { id })
              void remove(id)
            }, ORPHAN_TIMEOUT_MS)
          }
        }
      },
    }
  }
}
