/**
 * PTY Module
 *
 * Removes opencode-specific abstractions (Instance, Bus, Shell, Plugin, Identifier)
 * and uses the runtime event bus directly.
 */

import { type IPty } from "@lydell/node-pty"
import z from "zod/v3"
import { Log } from "../log"
import type { WSContext } from "hono/ws"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { BIN_DIR, getTerminalEnvVars, isSetupComplete, setupAgentHooks } from "../agent-hooks"
import { cleanupOrphanedHistory, createDiskHistory, renameHistory } from "./history-disk"
import { CLEAR_SCROLLBACK, extractContentAfterClear } from "./escape-filter"
import { osc7 as osc7Parser } from "./osc7"
import { oscProcessExit } from "./osc-process-exit"
import { buildSafeEnv, getLocale } from "./env"
import { resolveCwd } from "./resolve-cwd"
import { workspaceId as runtimeWorkspaceId } from "../target"
import { terminalHookWorkspaceId } from "./hook-workspace-id"
import { disposeMode } from "./dispose-mode"
import {
  type QueuedOperation,
  type WriteQueueSession,
  operationBytes,
  enqueueWrite,
  flushWriteQueue,
} from "./write-queue"
import { decodeInput } from "./decode-input"
import { sendWebSocketWithBackpressure } from "./websocket-backpressure"
import { safeChunkEnd, safeStartIndex } from "./safe-slice"
import { createMarkerScanner } from "./marker-scan"
import { SHELL_READY_MARKER } from "./shell-ready"
import { TERMINAL_TERM_PROGRAM, TERMINAL_TERM_PROGRAM_VERSION } from "./identity"
import { SESSION_RESTORED_NOTICE, shouldMarkRestored } from "./restored-notice"
import { createModeTracker, type ModeTracker } from "./mode-tracker"
import { sanitizeReplay } from "./replay-sanitize"
import { workspaceRuntimeBus, type PtyInfo } from "../bus"
import { ensureSpawnHelper } from "./spawn-helper-fix"
import { prependWorkspaceRuntimeBin } from "../runtime-bin"
import type {
  ProcessObserver,
  ProcessOwnerHandle,
  ProcessOwnerKind,
  ProcessOwnerOperations,
} from "../managed-processes/process-observer"

async function getSpawn() {
  await ensureSpawnHelper()
  return (await import("@lydell/node-pty")).spawn
}

export function selectPtyCommand(input: {
  command?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  userShell?: () => string | null | undefined
}) {
  if (input.command) return input.command
  const env = input.env ?? process.env
  if (env.SHELL) return env.SHELL
  if ((input.platform ?? process.platform) === "win32") return env.COMSPEC || "cmd.exe"
  try {
    return (input.userShell ?? (() => os.userInfo().shell))() || "/bin/sh"
  } catch {
    return "/bin/sh"
  }
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

  /**
   * ## Per-session memory contract
   *
   * Everything a live PTY holds in RAM is bounded here. Total server-side
   * terminal memory is therefore (sessions × the sum below), and the session
   * count is itself bounded by orphan reaping (see `orphanTimeoutMs`).
   *
   *   BUFFER_LIMIT          2 MB code units  — the replay buffer, ~2–4 MB heap
   *   QUEUE_HIGH_WATERMARK  1 MB             — pending writes to a slow pty
   *   modeTracker                            — headless xterm, scrollback: 0
   *
   * History is NOT in this list: it lives only on disk (see history-disk.ts).
   * It used to be mirrored in RAM at HISTORY_LIMIT — 16 MB per terminal, for
   * data that was already durable and read at most once per session lifetime.
   */
  const BUFFER_LIMIT = 1024 * 1024 * 2
  const WEBSOCKET_BUFFERED_AMOUNT_MAX = (() => {
    const raw = Number(process.env.OPENCODE_PTY_WS_BUFFERED_AMOUNT_MAX)
    if (!Number.isFinite(raw) || raw <= 0) return 1024 * 1024
    return Math.floor(raw)
  })()
  /** DISK cap per transcript. Not a memory cost — nothing mirrors it in RAM. */
  const HISTORY_LIMIT = (() => {
    const raw = Number(process.env.OPENCODE_PTY_HISTORY_LIMIT)
    if (!Number.isFinite(raw) || raw <= 0) return 1024 * 1024 * 16
    return Math.floor(raw)
  })()
  /**
   * How long a transcript stays restorable after its last write. Past this,
   * no session can still name it via `previousPtyId`, so it is only occupying
   * disk. Swept once per process — see `sweepStaleHistoryOnce`.
   */
  const HISTORY_RETENTION_MS = (() => {
    const raw = Number(process.env.OPENCODE_PTY_HISTORY_RETENTION_MS)
    if (!Number.isFinite(raw) || raw <= 0) return 7 * 24 * 60 * 60 * 1000
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
  const orphanTimeoutMs = () => {
    const raw = Number(process.env.OPENCODE_PTY_ORPHAN_TIMEOUT_MS)
    if (!Number.isFinite(raw) || raw <= 0) return 60_000
    return Math.floor(raw)
  }
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const sample = (value: string) =>
    value
      .replaceAll("\r", "\\r")
      .replaceAll("\n", "\\n")
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "<esc>")
      .slice(0, 80)
  const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`
  const agentInitialCommand = (value: string) => {
    const match = value.match(/^(\s*)(claude|codex|gemini|cursor)(?=\s|$)(.*)$/)
    if (!match) return value
    const command = match[2]
    if (!command) return value
    const wrapper = path.join(BIN_DIR, command)
    if (!fs.existsSync(wrapper)) return value
    return `${match[1] ?? ""}${shellQuote(wrapper)}${match[3] ?? ""}`
  }

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
      let i = 0
      while (i < replay.length) {
        // A fixed-stride slice can end between the halves of a surrogate pair,
        // which makes the outgoing text frame invalid UTF-8. Escapes split
        // across sends are fine — xterm reassembles them across writes.
        const end = safeChunkEnd(replay, Math.min(replay.length, i + BUFFER_CHUNK))
        // Degenerate guard: a pair straddling the very first boundary would
        // otherwise pin `end` at `i` and spin forever.
        const stop = end > i ? end : Math.min(replay.length, i + BUFFER_CHUNK)
        if (!sendWebSocketWithBackpressure(ws, replay.slice(i, stop), {
          maxBufferedBytes: WEBSOCKET_BUFFERED_AMOUNT_MAX,
        })) {
          return false
        }
        i = stop
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
      if (!sendWebSocketWithBackpressure(ws, data, { maxBufferedBytes: WEBSOCKET_BUFFERED_AMOUNT_MAX })) {
        session.subscribers.delete(ws)
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
    initialCommand: z.string().optional(),
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
    /**
     * This session replaced a lost PTY and its buffer was seeded from disk
     * history, so the first client to attach should be shown a separator
     * between the restored content and the fresh shell. Consumed by the first
     * SUCCESSFUL replay (see connect) — a send that fails leaves it set so the
     * next attach still marks the seam.
     */
    restoredNoticePending: boolean
    /**
     * Headless emulator mirroring this PTY's output, so a reattaching renderer
     * can be resynced to the modes the RUNNING program actually has set rather
     * than to a snapshot the renderer guessed earlier. See mode-tracker.ts.
     */
    modeTracker: ModeTracker
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
    /**
     * Public PTY creation is a two-phase ownership transfer. `create()` owns a
     * provisional process until the HTTP route has produced a successful
     * response; `commit()` transfers that process to the user. A committed
     * running terminal is intentionally independent of WebSocket subscribers.
     */
    committed: boolean
    addrInUse: boolean
    orphanTimer: ReturnType<typeof setTimeout> | undefined
    interruptTimer: ReturnType<typeof setTimeout> | undefined
    cleanupOperation?: Promise<void>
    removeOperation?: Promise<void>
    owner?: ProcessOwnerHandle
    /** Verified relay actor that created this public terminal. Never accepted
     * from request input and deliberately absent from the public PTY info. */
    accessOwnerActorId?: string
  }

  function clearInterrupt(session: ActiveSession) {
    if (!session.interruptTimer) return
    clearTimeout(session.interruptTimer)
    session.interruptTimer = undefined
  }

  function clearOrphanTimer(session: ActiveSession) {
    if (!session.orphanTimer) return
    clearTimeout(session.orphanTimer)
    session.orphanTimer = undefined
  }

  function armOrphanTimer(id: string, session: ActiveSession) {
    if (session.managed || session.committed || session.exited || session.removed || session.orphanTimer) return
    const timeoutMs = orphanTimeoutMs()
    log.info("provisional PTY cleanup timer started", { id, timeoutMs })
    session.orphanTimer = setTimeout(() => {
      const current = sessions.get(id)
      if (!current) return
      current.orphanTimer = undefined
      if (current.managed || current.committed || current.subscribers.size > 0 || current.exited || current.removed) return
      log.info("provisional PTY cleanup timer fired", { id })
      void remove(id)
    }, timeoutMs)
    session.orphanTimer.unref?.()
  }

  function interrupt(id: string, session: ActiveSession) {
    if (!session.managed) return
    if (session.interruptTimer) return
    session.interruptTimer = setTimeout(() => {
      session.interruptTimer = undefined
      if (session.exited || session.removed || session.info.status !== "running") return
      workspaceRuntimeBus.publish({ type: "pty.stream", id, kind: "command-exit", exitCode: 130 })
    }, 150)
  }

  function cleanupSession(id: string, session: ActiveSession, reason: "exit" | "remove") {
    session.cleanupOperation ??= cleanupSessionOwned(id, session, reason)
    return session.cleanupOperation
  }

  async function cleanupSessionOwned(id: string, session: ActiveSession, reason: "exit" | "remove") {
    if (session.removed) return
    // Claim explicit removal before the asynchronous process-tree sweep. This
    // makes cleanup single-owner when a provisional timer, dispose(), and the
    // native exit callback race each other.
    if (reason === "remove") session.removed = true

    clearInterrupt(session)
    // Release the headless emulator on BOTH paths — it holds a parser and a
    // screen buffer per session, so leaking one per terminal adds up.
    session.modeTracker.dispose()

    clearOrphanTimer(session)

    if (reason === "exit") {
      await session.history.close()

      for (const ws of session.subscribers) {
        ws.close()
      }
      session.subscribers.clear()

      // unref'd: an exited session's retention sweep must not hold the
      // process open — a runtime (or test runner) with nothing else left to
      // do should exit instead of idling out this timer.
      setTimeout(() => {
        if (sessions.get(id) === session) {
          for (const ws of session.subscribers) {
            ws.close()
          }
          session.subscribers.clear()
          sessions.delete(id)
          session.removed = true
        }
      }, 1000 * 60).unref?.()
      return
    }

    session.ready = false
    for (const ws of session.subscribers) {
      ws.close()
    }
    session.subscribers.clear()
    session.writeQueue = []
    session.queuedBytes = 0
    // The native PTY owns the process even when the platform cannot expose a
    // usable OS pid (the Windows ConPTY wrapper reports 0 in that case).
    // Always close it through its native handle; the PID-based tree sweep is
    // additional cleanup only when a real pid is available.
    try {
      session.process.kill()
    } catch {}
    try {
      await killProcessTree(session.info.pid)
    } catch {}
    await session.history.close()
    sessions.delete(id)
  }

  const sessions = new Map<string, ActiveSession>()

  /**
   * Sweep transcripts nothing can restore from any more.
   *
   * `cleanupOrphanedHistory` existed but was never called, so buckets grew
   * without bound — one project directory was found holding 314 log files. A
   * history file is only reachable by a session naming its id via
   * `previousPtyId`, which happens on the next attach after a loss; past the
   * retention window nothing ever will.
   *
   * Runs once, lazily, on the first session created in this process: it needs
   * no scheduler, cannot delay startup, and a runtime that never opens a
   * terminal never pays for it. Failures are swallowed — a full disk or a
   * permission error must not stop a terminal from opening.
   */
  let historySweepStarted = false
  function sweepStaleHistoryOnce() {
    if (historySweepStarted) return
    historySweepStarted = true
    void cleanupOrphanedHistory(undefined, HISTORY_RETENTION_MS)
      .then((result) => {
        if (result?.removed) log.info("swept stale pty history", { removed: result.removed })
      })
      .catch(() => {})
  }

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
      committed: s.committed,
      orphanTimerActive: !!s.orphanTimer,
    }))
  }

  export function activity() {
    let running = 0
    let committed = 0
    let provisional = 0
    let managed = 0
    let subscribers = 0
    for (const session of sessions.values()) {
      if (session.removed || session.exited || session.info.status !== "running") continue
      running++
      subscribers += session.subscribers.size
      if (session.managed) managed++
      else if (session.committed) committed++
      else provisional++
    }
    return { running, committed, provisional, managed, subscribers }
  }

  export function commit(id: string) {
    const session = sessions.get(id)
    if (!session || session.removed || session.exited) return
    session.committed = true
    clearOrphanTimer(session)
    return session.info
  }

  export function get(id: string) {
    return sessions.get(id)?.info
  }

  /** Bind access only after the public route has created the PTY itself. */
  export function bindAccessOwner(id: string, actorId: string) {
    const session = sessions.get(id)
    if (!session || session.removed) return false
    if (session.accessOwnerActorId && session.accessOwnerActorId !== actorId) return false
    session.accessOwnerActorId = actorId
    return true
  }

  export function accessOwner(id: string) {
    return sessions.get(id)?.accessOwnerActorId
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

  export async function create(
    input: CreateInput,
    observation?: {
      observer: ProcessObserver
      kind: Extract<ProcessOwnerKind, "pty" | "managed-process">
      ownerId: string
      workspaceId: string
      directory: string
      label: string
      sessionId?: string
      operations?: ProcessOwnerOperations
    },
  ) {
    const createStart = performance.now()
    const id = "pty_" + crypto.randomUUID().replace(/-/g, "")
    const command = selectPtyCommand({ command: input.command })
    const args = input.args || []
    const shellName = command.split(/[\\/]/).pop() || ""
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
      // Caller-supplied PTY env: explicit, so not subject to the ambient
      // CLAXEDO_ allowlist (see SafeEnvSource).
      ...buildSafeEnv(inputEnv, { customPrefix: "CLAXEDO", source: "explicit" }),
      ...shellEnv.env,
      TERM: "xterm-256color",
      // Describe OUR terminal, not whatever launched the desktop app. These
      // come after the allowlist spread so they override the inherited values
      // — a TUI seeing the host's `Apple_Terminal` tunes for the wrong
      // terminal. See identity.ts for why this value is `vscode` and what it
      // is coupled to.
      TERM_PROGRAM: TERMINAL_TERM_PROGRAM,
      TERM_PROGRAM_VERSION: TERMINAL_TERM_PROGRAM_VERSION,
      OPENCODE_TERMINAL: "1",
      COLORFGBG: "15;0",
    } as Record<string, string>
    env.PATH = prependWorkspaceRuntimeBin(env.PATH)
    const claxedoPort = env.CLAXEDO_PORT
    const port = claxedoPort ? parseInt(claxedoPort, 10) || 7860 : 0

    const t1 = performance.now()
    const setupComplete = claxedoPort ? await ensureSetup(port) : false
    const ensureSetupMs = performance.now() - t1

    if (claxedoPort && setupComplete) {
      const tabId = env.CLAXEDO_TAB_ID || id
      const terminalId = env.CLAXEDO_TERMINAL_ID || id
      // The agent hooks post this straight back as `?workspaceId=` (see
      // agent-hooks/templates notify.sh), and the runtime resolves that as a
      // workspace IDENTITY. Falling back to `cwd` put a directory path in that
      // slot, so every hook call 404'd — silently, because notify.sh
      // backgrounds its curl and discards the response. Net effect: no
      // `agent.lifecycle` event ever reached the app, so a coding agent running
      // in a terminal never showed working/permission status. Verified against
      // a live server: `?workspaceId=<cwd path>` → 404,
      // `?workspaceId=<uuid>` → 200 {"success":true}.
      const workspaceId = terminalHookWorkspaceId({
        envWorkspaceId: env.CLAXEDO_WORKSPACE_ID,
        runtimeWorkspaceId: () => runtimeWorkspaceId(),
      })

      const agentEnv = getTerminalEnvVars({
        tabId,
        terminalId,
        workspaceId,
        port,
        shell: command,
      })

      Object.assign(env, agentEnv)
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
    const observedPid = Number.isInteger(info.pid) && info.pid > 0 ? info.pid : undefined
    const owner = observation?.observer.register(
      {
        ownerId: observation.ownerId,
        ownerGeneration: crypto.randomUUID(),
        launchId: crypto.randomUUID(),
        kind: observation.kind,
        role: observation.kind,
        label: observation.label,
        ...(observedPid !== undefined ? { pid: observedPid } : {}),
        workspaceId: observation.workspaceId,
        directory: observation.directory,
        ...(observation.sessionId ? { sessionId: observation.sessionId } : {}),
      },
      observation.operations ?? {
        stopGracefully: async () => remove(info.id),
        ...(observedPid !== undefined
          ? { killOwnedTree: async () => killProcessTree(observedPid) }
          : {}),
      },
    )

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
    // Fire-and-forget, once per process, after the first terminal exists.
    sweepStaleHistoryOnce()
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

    // Read from disk (async — the history is no longer mirrored in RAM). Capped
    // at BUFFER_LIMIT because that is what `session.buffer` can hold; seeding
    // more would only be trimmed straight back off.
    const restored = previousPtyId ? await history.snapshot(BUFFER_LIMIT) : ""
    const initialCommand = input.initialCommand?.trim() ? agentInitialCommand(input.initialCommand) : undefined
    let initialCommandSent = false
    let initialCommandTimer: ReturnType<typeof setTimeout> | undefined
    // Per-session, because the carry is stream state.
    const shellReadyScanner = createMarkerScanner(SHELL_READY_MARKER)
    const clearScrollbackScanner = createMarkerScanner(CLEAR_SCROLLBACK)
    let clearScrollbackCarry = ""
    const sendInitialCommand = (reason: string) => {
      if (!initialCommand || initialCommandSent) return
      initialCommandSent = true
      if (initialCommandTimer) {
        clearTimeout(initialCommandTimer)
        initialCommandTimer = undefined
      }
      log.info("pty initial command sent", { id, reason })
      try {
        ptyProcess.write(initialCommand + "\n")
      } catch (err) {
        log.warn("failed to write initial command", { id, err: String(err) })
      }
    }

    const session: ActiveSession = {
      info,
      process: ptyProcess,
      buffer: restored,
      bufferCursor: 0,
      cursor: restored.length,
      // Deliberately NOT concatenated into `buffer`: the buffer is bounded by
      // BUFFER_LIMIT and trimmed from the head, so a burst of output before any
      // client attached would evict the notice first — exactly the seam we want
      // to mark. Kept as session state and prepended at replay time instead,
      // which makes it immune to trimming by construction.
      restoredNoticePending: shouldMarkRestored({ previousPtyId, restoredLength: restored.length }),
      // @lydell/node-pty's own default geometry; the client's first resize on attach
      // brings both the pty and this emulator to the real size. Geometry only
      // affects where the emulator wraps, not which modes it records, so a
      // brief mismatch cannot corrupt the preamble.
      modeTracker: createModeTracker(80, 24),
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
      committed: false,
      addrInUse: false,
      orphanTimer: undefined,
      interruptTimer: undefined,
      ...(owner ? { owner } : {}),
    }
    sessions.set(id, session)
    armOrphanTimer(id, session)
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

      // Chunk-safe: a plain `data.includes(...)` missed the marker whenever a
      // PTY read boundary fell inside it, and the initial command then waited
      // out the 1200ms fallback timer instead of firing at the prompt.
      if (initialCommand && shellReadyScanner.scan(data)) {
        if (initialCommandTimer) clearTimeout(initialCommandTimer)
        initialCommandTimer = setTimeout(() => sendInitialCommand("shell-ready"), 10)
      }

      session.cursor += data.length

      const parsed = osc7(session.osc7, data)
      session.osc7 = parsed.buf
      if (parsed.cwd && parsed.cwd !== session.info.cwd) {
        session.info.cwd = parsed.cwd
        workspaceRuntimeBus.publish({ type: "pty.updated", info: session.info })
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
        try {
          session.process.write("\x15")
        } catch {}
        workspaceRuntimeBus.publish({ type: "pty.stream", id, kind: "command-exit", exitCode: exitParsed.exitCode })
      }

      // Mirror into the headless emulator BEFORE broadcasting, so a client that
      // attaches in the same tick gets a preamble that already includes
      // whatever this chunk just set.
      session.modeTracker.feed(data)

      safeBroadcast(session, data)

      session.buffer += data
      if (session.buffer.length > BUFFER_LIMIT) {
        // Cut on a safe boundary: a raw `slice(excess)` can land inside an
        // escape sequence, and the replay then starts mid-CSI — xterm prints
        // the parameter bytes as literal junk at the top of the scrollback.
        // `bufferCursor` advances by the ACTUAL cut so the invariant
        // `bufferCursor + buffer.length === cursor` still holds for connect().
        const cut = safeStartIndex(session.buffer, session.buffer.length - BUFFER_LIMIT)
        session.buffer = session.buffer.slice(cut)
        session.bufferCursor += cut
      }
      if (session.managed && busy(data)) {
        session.addrInUse = true
        workspaceRuntimeBus.publish({ type: "pty.stream", id, kind: "data", tail: snapshot(id, 16_384) })
      }

      const filtered = (() => {
        // Chunk-safe: the scanner carries a tail so an ED3 split across two PTY
        // reads still clears history. `carry` gives extractContentAfterClear
        // the same view so it can strip the tail of a straddling sequence.
        const carry = clearScrollbackCarry
        clearScrollbackCarry = data.slice(Math.max(0, data.length - (CLEAR_SCROLLBACK.length - 1)))
        if (!clearScrollbackScanner.scan(data)) return data
        void session.history.clear()
        return extractContentAfterClear(data, carry)
      })()
      if (filtered) session.history.append(filtered)
    })
    if (initialCommand) {
      initialCommandTimer = setTimeout(() => sendInitialCommand("fallback"), 1200)
    }
    ptyProcess.onExit(async ({ exitCode }) => {
      if (session.exited || session.removed) return
      session.exited = true
      if (initialCommandTimer) {
        clearTimeout(initialCommandTimer)
        initialCommandTimer = undefined
      }
      clearInterrupt(session)
      log.info("session exited", { id, exitCode })
      session.info.status = "exited"
      const tail = snapshot(id, 16_384)
      workspaceRuntimeBus.publish({ type: "pty.exited", id, exitCode, tail })
      workspaceRuntimeBus.publish({ type: "pty.stream", id, kind: "exit", exitCode, tail })
      session.owner?.exit({ reason: "exited", exitCode })
      await cleanupSession(id, session, "exit")
    })
    workspaceRuntimeBus.publish({ type: "pty.created", info })
    return info
  }

  export async function update(id: string, input: UpdateInput) {
    const session = sessions.get(id)
    if (!session) return
    if (input.title) {
      session.info.title = input.title
    }
    if (input.size) {
      if (!session.ready) {
        enqueueWrite(session, { type: "resize", cols: input.size.cols, rows: input.size.rows })
      } else {
        session.modeTracker.resize(input.size.cols, input.size.rows)
        session.process.resize(input.size.cols, input.size.rows)
      }
    }
    workspaceRuntimeBus.publish({ type: "pty.updated", info: session.info })
    return session.info
  }

  export async function remove(id: string) {
    const session = sessions.get(id)
    if (!session) return
    session.removeOperation ??= (async () => {
      log.info("removing session", { id })
      const alreadyExited = session.exited
      await cleanupSession(id, session, "remove")
      // Native exit cleanup may already own `cleanupOperation`. Explicit
      // remove still owns the stronger public contract: after it resolves the
      // session must no longer be addressable, rather than waiting for exit
      // retention.
      if (sessions.get(id) === session) {
        session.removed = true
        sessions.delete(id)
      }
      if (!alreadyExited) session.owner?.exit({ reason: "disposed" })
      workspaceRuntimeBus.publish({ type: "pty.deleted", id })
    })()
    await session.removeOperation
  }

  export async function dispose() {
    for (const id of Array.from(sessions.keys())) {
      await remove(id)
    }
  }

  export function resize(id: string, cols: number, rows: number) {
    const session = sessions.get(id)
    if (session && session.info.status === "running") {
      if (!session.ready) {
        enqueueWrite(session, { type: "resize", cols, rows })
        return
      }
      session.modeTracker.resize(cols, rows)
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

    clearOrphanTimer(session)

    const start = session.bufferCursor
    const end = session.cursor

    const from =
      cursor === -1 ? end : typeof cursor === "number" && Number.isSafeInteger(cursor) ? Math.max(0, cursor) : 0
    const data = (() => {
      if (!session.buffer) return ""
      if (from >= end) return ""
      const offset = Math.max(0, from - start)
      if (offset >= session.buffer.length) return ""
      // A replay is a RECORDING. Queries in it would make the reattaching
      // terminal answer a program that asked minutes ago — and if that program
      // has exited, the shell now reading the pty echoes the reply as typed
      // input. Mode sets in it would re-arm mouse/focus/kitty for a program
      // that may be gone. Modes come from the live preamble below instead.
      return sanitizeReplay(session.buffer.slice(offset))
    })()

    // Append the seam marker AFTER the restored content and before the fresh
    // shell's first output, so it reads as a rule between the two. Only for a
    // client that is actually receiving the restored buffer: a reconnect asking
    // for the live tail (`cursor === -1`) has already seen it, or wants only
    // what is new, and would get the rule stranded at the bottom.
    // Mode preamble FIRST, from live emulator state. Mode-setting escapes are
    // emitted once at program startup and broadcast away rather than buffered,
    // so a fresh xterm needs them re-asserted on every attach — even when the
    // replay itself is empty (a live-tail reconnect to a running TUI).
    const preamble = session.modeTracker.buildPreamble()
    const showNotice = session.restoredNoticePending && data.length > 0
    const body = showNotice ? data + SESSION_RESTORED_NOTICE : data
    if (!safeReplay(ws, preamble + body)) {
      session.subscribers.delete(ws)
      workspaceRuntimeBus.publish({ type: "pty.stream", id, kind: "error", message: "replay_send_failed" })
      ws.close()
      return
    }
    // Consumed only now — a failed send above returns early and leaves the flag
    // set, so the next attach still marks the seam.
    if (showNotice) session.restoredNoticePending = false

    if (!sendWebSocketWithBackpressure(ws, meta(end), { maxBufferedBytes: WEBSOCKET_BUFFERED_AMOUNT_MAX })) {
      session.subscribers.delete(ws)
      return
    }

    session.ready = true
    flushWriteQueue(session)

    return {
      onMessage: (message: unknown) => {
        const input = decodeInput(message, decoder)
        if (!input) {
          return
        }
        if (session.info.status !== "running") {
          return
        }
        if (input.includes("\x03")) {
          interrupt(id, session)
        }
        session.process.write(input)
      },
      onClose: () => {
        log.info("client disconnected from session", { id })
        session.subscribers.delete(ws)
        workspaceRuntimeBus.publish({ type: "pty.stream", id, kind: "disconnect" })
        if (session.subscribers.size === 0) {
          session.ready = false
          armOrphanTimer(id, session)
        }
      },
    }
  }
}
