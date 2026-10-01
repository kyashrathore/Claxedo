import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { LaunchRefusedError, identityFromSpawn, launchErrorText, readCreationIdentity, type LaunchOwnershipStore } from "@claxedo/process-ownership/launch"
import { Log } from "../log"
import { shellQuote } from "@claxedo/helpers"
import { BIN_DIR, getTerminalEnvVars, isSetupComplete, setupAgentHooks } from "../agent-hooks"
import { cleanupOrphanedHistory, createDiskHistory, renameHistory } from "./history-disk"
import { CLEAR_SCROLLBACK, extractContentAfterClear } from "./escape-filter"
import { osc7 as osc7Parser } from "./osc7"
import { buildSafeEnv, getLocale } from "./env"
import { resolveCwd } from "./resolve-cwd"
import { workspaceId as runtimeWorkspaceId } from "../target"
import { terminalHookWorkspaceId } from "./hook-workspace-id"
import { safeStartIndex } from "./safe-slice"
import { createMarkerScanner } from "./marker-scan"
import { SHELL_READY_MARKER } from "./shell-ready"
import { TERMINAL_TERM_PROGRAM, TERMINAL_TERM_PROGRAM_VERSION } from "./identity"
import { SESSION_RESTORED_NOTICE, shouldMarkRestored } from "./restored-notice"
import { createModeTracker } from "./mode-tracker"
import { currentSessionCore } from "../session-context"
import { ensureSpawnHelper } from "./spawn-helper-fix"
import { prependWorkspaceRuntimeBin } from "../runtime-bin"
import type { ActiveSession, CreateInput, AgentHookAccessBinding } from "./session-types"

const log = Log.create({ service: "pty" })
type StartContext = {
  bufferLimit: number
  highWatermark: number
  lowWatermark: number
  register(session: ActiveSession): void
  broadcast(session: ActiveSession, data: string | Uint8Array): void
  checkpoint(session: ActiveSession): void
  exited(session: ActiveSession, exitCode: number): Promise<void>
}

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

const HISTORY_LIMIT = (() => {
  const raw = Number(process.env.CLAXEDO_PTY_HISTORY_LIMIT)
  if (!Number.isFinite(raw) || raw <= 0) return 1024 * 1024 * 16
  return Math.floor(raw)
})()
/**
 * How long a transcript stays restorable after its last write. Past this,
 * no session can still name it via `previousPtyId`, so it is only occupying
 * disk. Swept once per process — see `sweepStaleHistoryOnce`.
 */
const HISTORY_RETENTION_MS = (() => {
  const raw = Number(process.env.CLAXEDO_PTY_HISTORY_RETENTION_MS)
  if (!Number.isFinite(raw) || raw <= 0) return 7 * 24 * 60 * 60 * 1000
  return Math.floor(raw)
})()
const agentInitialCommand = (value: string) => {
  const match = value.match(/^(\s*)(claude|codex|gemini|cursor)(?=\s|$)(.*)$/)
  if (!match) return value
  const command = match[2]
  if (!command) return value
  const wrapper = path.join(BIN_DIR, command)
  if (!fs.existsSync(wrapper)) return value
  return `${match[1] ?? ""}${shellQuote(wrapper)}${match[3] ?? ""}`
}

// History storage failures must not delay or prevent terminal creation.
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

export async function startTerminal(
  input: CreateInput,
  /**
   * Required, and never defaulted here: a caller with no durable store passes
   * `volatileLaunchOwnership()` itself, so a terminal nothing can reconcile
   * after a restart is a visible decision at the call site.
   */
  ownership: LaunchOwnershipStore,
  agentHookAccess: AgentHookAccessBinding | undefined,
  platform: NodeJS.Platform,
  context: StartContext,
) {
  const { bufferLimit: BUFFER_LIMIT, highWatermark: QUEUE_HIGH_WATERMARK, lowWatermark: QUEUE_LOW_WATERMARK } = context
  const bus = currentSessionCore().bus
  const createStart = performance.now()
  const id = "pty_" + crypto.randomUUID().replace(/-/g, "")
  const command = selectPtyCommand({ command: input.command, platform })
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

  const { previousPtyId: _prevPty, ...inputEnv } = input.env || {}
  const env = {
    ...buildSafeEnv(process.env, { customPrefix: "CLAXEDO" }),
    // Caller-supplied PTY env: explicit, so not subject to the ambient
    // CLAXEDO_ allowlist (see SafeEnvSource).
    ...buildSafeEnv(inputEnv, { customPrefix: "CLAXEDO", source: "explicit" }),
    TERM: "xterm-256color",
    // Describe OUR terminal, not whatever launched the desktop app. These
    // come after the allowlist spread so they override the inherited values
    // — a TUI seeing the host's `Apple_Terminal` tunes for the wrong
    // terminal. See identity.ts for why this value is `vscode` and what it
    // is coupled to.
    TERM_PROGRAM: TERMINAL_TERM_PROGRAM,
    TERM_PROGRAM_VERSION: TERMINAL_TERM_PROGRAM_VERSION,
    CLAXEDO_TERMINAL: "1",
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
    // Posted straight back by agent hooks as `?workspaceId=` (see
    // agent-hooks/templates notify.sh) and resolved as a workspace
    // identity; see `terminalHookWorkspaceId` for why a directory path in
    // this slot fails silently.
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

  if (platform === "win32") {
    env.LC_ALL = "C.UTF-8"
    env.LC_CTYPE = "C.UTF-8"
    env.LANG = "C.UTF-8"
  } else if (!env.LANG) {
    env.LANG = getLocale(process.env)
  }
  log.info("creating session", {
    id,
    cmd: command,
    args,
    cwd,
    ...(input.env?.previousPtyId ? { restoring: input.env.previousPtyId } : {}),
  })

  const t2 = performance.now()
  const spawn = await getSpawn()
  const ptyImportMs = performance.now() - t2

  // Prepared before the spawn: a terminal is only acknowledged once something
  // durable can name it again. `forkpty` cannot carry the gate's private
  // channel without taking the shell's session leadership away from it, so
  // this launch records its identity immediately after the spawn instead and
  // reconciles a crash in that window as unknown rather than as no execution.
  const prepared = await ownership
    .prepare({
      role: "terminal",
      protocol: "direct",
      scope: {
        directory: cwd,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      },
    })
    .catch((error: unknown) => { throw new LaunchRefusedError("terminal", error) })

  const t3 = performance.now()
  const spawnedAt = Date.now()
  const ptyProcess = spawn(command, args, {
    name: "xterm-256color",
    cwd,
    env,
  })
  const spawnMs = performance.now() - t3
  let nativeExit: { exitCode: number } | undefined
  let handleExit: ((event: { exitCode: number }) => Promise<void>) | undefined
  const exitSubscription = ptyProcess.onExit((event) => {
    nativeExit = event
    if (handleExit) void handleExit(event)
  })
  // ConPTY exposes pid 0 until its output pipe connects; node-pty allows 5 s.
  // Subscribe before waiting so a shell that exits during admission stays exited.
  const deadline = Date.now() + 6_000
  const knownPid = () => Number.isInteger(ptyProcess.pid) && ptyProcess.pid > 0
  if (platform === "win32") {
    while (!knownPid() && !nativeExit && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const pid = ptyProcess.pid
  const observed = Number.isInteger(pid) && pid > 0
    ? await readCreationIdentity(pid).catch((error: unknown) => {
        log.error("could not read the terminal's creation identity; it cannot be retired by signal", { id, pid, error: String(error) })
        return undefined
      })
    : undefined
  // The PTY library's own spawn helper is the child's parent, not this
  // runtime, so parentage proves nothing. What does: a process that already
  // existed before this spawn cannot be the one this spawn created, and a
  // pid that is not its own group leader is not a terminal session.
  const started = identityFromSpawn(observed, spawnedAt)
  const identity = started && started.processGroupId === started.pid ? started : undefined
  if (observed && !identity) {
    log.error("the PTY reported a pid this spawn cannot own; it will not be signalled", {
      id,
      pid: observed.pid,
      startedAtMs: observed.startedAtMs,
      processGroupId: observed.processGroupId,
      spawnedAt,
    })
  }
  let unrecorded: string | undefined
  if (identity) {
    try {
      await ownership.recordIdentity(prepared.launchId, identity)
    } catch (error) {
      unrecorded = launchErrorText(error)
      log.error("PTY creation identity could not be recorded; this terminal is unowned", { id, pid: identity.pid, error: unrecorded })
    }
  }

  const info: ActiveSession["info"] = {
    id,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.createRequestId ? { createRequestId: input.createRequestId } : {}),
    title: input.title || `Terminal ${id.slice(-4)}`,
    command,
    args,
    cwd,
    status: "running",
    pid,
  }

  const previousPtyId = input.env?.previousPtyId
  if (previousPtyId) {
    try {
      await renameHistory(cwd, previousPtyId, id)
    } catch (err) {
      log.info("history rename failed", { previousPtyId, id, err: String(err) })
    }
  }

  const t4 = performance.now()
  const history = await createDiskHistory({
    directory: cwd,
    id,
    limit: HISTORY_LIMIT,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  })
  // Fire-and-forget, once per process, after the first terminal exists.
  sweepStaleHistoryOnce()
  const diskHistoryMs = performance.now() - t4

  const totalMs = performance.now() - createStart
  log.info("pty.create timing", {
    id,
    totalMs: Math.round(totalMs),
    ensureSetupMs: Math.round(ensureSetupMs),
    ptyImportMs: Math.round(ptyImportMs),
    spawnMs: Math.round(spawnMs),
    diskHistoryMs: Math.round(diskHistoryMs),
    setupComplete,
    hasClaxedoPort: !!claxedoPort,
  })

  // Read from disk (an async op) and capped at BUFFER_LIMIT — that is what
  // `session.buffer` can hold, so seeding more would only be trimmed
  // straight back off.
  const restored = previousPtyId ? await history.snapshot(BUFFER_LIMIT - SESSION_RESTORED_NOTICE.length) : ""
  const notice = shouldMarkRestored({ previousPtyId, restoredLength: restored.length }) ? SESSION_RESTORED_NOTICE : ""
  // The seam belongs before fresh shell output and inside the stream cursor.
  // Adding it on attach would place it after an already-drawn prompt, where
  // the shell's next redraw can erase it or overwrite user input.
  if (notice) history.append(notice)
  if (previousPtyId) log.info("pty history restored", { id, previousPtyId, restoredChars: restored.length })
  const restoredBuffer = restored + notice
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
    bus,
    info,
    process: ptyProcess,
    buffer: restoredBuffer,
    bufferCursor: 0,
    cursor: restoredBuffer.length,
    // @lydell/node-pty's own default geometry; the client's first resize on attach
    // brings both the pty and its checkpoint owner to the real size.
    modeTracker: createModeTracker(80, 24),
    onResize() {
      try {
        context.checkpoint(session)
      } catch (error) {
        log.warn("pty resize checkpoint failed", { id, error: String(error) })
        for (const ws of session.subscribers) ws.close(1011, "terminal checkpoint unavailable")
        session.subscribers.clear()
      }
    },
    history,
    osc7: "",
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
    committed: false,
    orphanTimer: undefined,
    launchId: prepared.launchId,
    store: ownership,
    ...(unrecorded ? { ownership: "unrecorded" as const, ownershipError: unrecorded } : {}),
    ...(identity ? { identity } : {}),
    ...(agentHookAccess ? { agentHookAccess } : {}),
  }
  if (restoredBuffer) session.modeTracker.feed(restoredBuffer)
  context.register(session)
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

    const parsed = osc7Parser(session.osc7, data)
    session.osc7 = parsed.buf
    if (parsed.cwd && parsed.cwd !== session.info.cwd) {
      session.info.cwd = parsed.cwd
      session.bus.publish({ type: "pty.updated", info: session.info })
    }

    // Mirror into the headless emulator BEFORE broadcasting, so a client that
    // attaches in the same tick gets a preamble that already includes
    // whatever this chunk just set.
    session.modeTracker.feed(data)

    context.broadcast(session, data)

    session.buffer += data
    if (session.buffer.length > BUFFER_LIMIT) {
      // Cut on a safe boundary: a raw `slice(excess)` can land inside an
      // escape sequence, and the replay then starts mid-CSI — xterm prints
      // the parameter bytes as literal junk at the top of the scrollback.
      // `bufferCursor` advances by the actual cut so the invariant
      // `bufferCursor + buffer.length === cursor` still holds for connect().
      const cut = safeStartIndex(session.buffer, session.buffer.length - BUFFER_LIMIT)
      session.buffer = session.buffer.slice(cut)
      session.bufferCursor += cut
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
  handleExit = async ({ exitCode }) => {
    exitSubscription.dispose()
    if (session.exited || session.removed) return
    if (initialCommandTimer) {
      clearTimeout(initialCommandTimer)
      initialCommandTimer = undefined
    }
    await context.exited(session, exitCode)
  }
  session.bus.publish({ type: "pty.created", info })
  if (nativeExit) await handleExit(nativeExit)
  return info
}
