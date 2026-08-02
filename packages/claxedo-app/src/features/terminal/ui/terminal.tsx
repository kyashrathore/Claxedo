import type { TerminalBackend } from "@/features/terminal/core/backend/types"
import { retry } from "@/features/terminal/core/retry"
import { ComponentProps, createEffect, createMemo, createSignal, onCleanup, onMount, splitProps } from "solid-js"
import { TerminalAccessoryRow } from "./accessory-row"
import { useSDK } from "@/features/terminal/app-ports"
import { monoFontFamily, useSettings } from "@/platform/settings/provider"
import { LocalPTY } from "@/features/terminal/providers/provider"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { useTheme } from "@opencode-ai/ui/theme"
import { useLanguage } from "@/platform/i18n/provider"
import { showToast } from "@opencode-ai/ui/toast"
import { claimInitialCommand, markInitialCommandRan, releaseInitialCommandClaim } from "@/features/terminal/core/terminal-recovery"
import { preparePersistBuffer, prepareRestoreBuffer } from "@/features/terminal/core/terminal-buffer"
import { hostStable, shouldRecoverDesync, shouldSendResize, sizeSane } from "@/features/terminal/core/terminal-geometry"
import {
  sigwinchToggleSize,
  WebSocketCloseError,
  reconnectDelay,
  MAX_RECONNECT_ATTEMPTS,
  reconnectingMessage,
  reconnectedMessage,
  reconnectFailedMessage,
  createTerminalPtyClient,
  openTerminalWebSocket,
} from "@/features/terminal/core/terminal-connection"
import { createTerminalRuntimeQueue } from "@/features/terminal/core/terminal-runtime-queue"
import { cursorPlan, initialDelay, isLikelyTui, restoreSize } from "@/features/terminal/core/reconnect-heuristics"
import { stripTerminalRepliesFromInput } from "@/features/terminal/core/input-reply-filter"
import { getCapabilityResponses } from "@/features/terminal/core/capability-responder"
import { authFetch, getClaxedoServerUrl } from "@/platform/api/api"
import { resolveWorkspaceRuntime } from "@/platform/runtime/cloud/workspace-runtime-store"
import { resolveTerminalReloadFlag, terminalReloadStorageKey } from "./pty-key-migration"
import { resolveInitialCommand } from "./initial-command"
import { buildRestoreWrite, shouldTrimRestoredTail, trimTrailingLines } from "./restore"
import { classifyTerminalClose } from "./close"
import { MIN_CONTAINER_PX, TERMINAL_OPTIONS } from "../core/config"
import { scheduleFontSettleRefit } from "../core/font-settle"

import { resolveTerminalColors, type TerminalColors } from "./terminal-colors"
import { createPtySnapshot } from "./terminal-pty-snapshot"
import { MAX_BATCH_BYTES, MAX_BATCH_ITEMS, MAX_DROPPED_CHUNKS, MAX_PENDING_BYTES, MAX_STREAM_BYTES, OPEN_RESIZE_SETTLE_MS } from "./terminal-limits"
export interface TerminalProps extends ComponentProps<"div"> {
  pty: LocalPTY
  autoFocus?: boolean
  onSubmit?: () => void
  onCleanup?: (pty: Partial<LocalPTY> & { id: string }) => void
  onUpdate?: (pty: Partial<LocalPTY> & { id: string }) => void
  onConnect?: () => void
  onConnectError?: (error: unknown) => void
  onAgentInterrupt?: () => void
  onSplitVertical?: () => void
  onSplitHorizontal?: () => void
  onFileLinkOpen?: (path: string, line?: number, col?: number, lineEnd?: number, colEnd?: number) => void
}



// Tuned for vtebench full profile (ramp stage 6: 1 MiB samples, max-secs=10,
// max-samples=200) so heavy TUI output can complete without early throttling.
// Baseline from stage 6 validation:
// dense_cells 11.55ms, medium_cells 10.72ms, scrolling 18.02ms,
// scrolling_bottom_region 17.95ms, scrolling_bottom_small_region 18.05ms,
// scrolling_fullscreen 23.53ms, scrolling_top_region 18.22ms,
// scrolling_top_small_region 18.04ms, sync_medium_cells 11.75ms, unicode 9.18ms.

export const Terminal = (props: TerminalProps) => {
  const sdk = useSDK()
  // CLAXEDO: PTYs live on claxedo-server — route WebSocket and size sync there
  const claxedoServerUrl = getClaxedoServerUrl()
  const settings = useSettings()
  const theme = useTheme()
  const language = useLanguage()
  const platform = usePlatform()
  const ptyRequest = platform.fetch ?? authFetch
  let workspaceIdPromise: Promise<string | undefined> | undefined
  let ptyClientPromise: Promise<ReturnType<typeof createTerminalPtyClient>> | undefined

  const terminalWorkspaceId = () => {
    // Prefer the SDK scope's stable relay-routing identity. For a relay-backed
    // (cloud / user-hosted) workspace `sdk.directory` is often the runtime's
    // filesystem path, which the control-plane resolve cannot map back to a
    // workspaceId (remote_directory is null on the hosted control plane) — so
    // resolving by directory returns undefined and the PTY socket falls back to
    // the central control plane and fails. Reusing `sdk.workspaceId` (the same
    // identity the composer/provider path uses) keeps the PTY on the relay.
    const scopeWorkspaceId = sdk.workspaceId
    if (scopeWorkspaceId) return Promise.resolve(scopeWorkspaceId)
    workspaceIdPromise ??= resolveWorkspaceRuntime({
      baseUrl: claxedoServerUrl,
      request: ptyRequest,
      directory: sdk.directory,
    })
      .then((workspace) =>
        (workspace?.kind === "cloud" || workspace?.kind === "user-hosted") && workspace.workspaceId
          ? workspace.workspaceId
          : undefined,
      )
      .catch(() => undefined)
    return workspaceIdPromise
  }

  const ptyClient = async () => {
    ptyClientPromise ??= terminalWorkspaceId().then((workspaceId) =>
      createTerminalPtyClient({
        serverUrl: claxedoServerUrl,
        workspaceId,
        directory: sdk.directory,
        request: ptyRequest,
      }),
    )
    return await ptyClientPromise
  }

  const updatePty = async (body: unknown) => {
    const response = await (await ptyClient()).update(local.pty.id, body)
    if (!response.ok) throw new Error((await response.text().catch(() => "")) || `PTY update failed: ${response.status}`)
  }

  let container!: HTMLDivElement
  const [local, others] = splitProps(props, ["pty", "autoFocus", "class", "classList", "onConnect", "onConnectError"])
  // A detached pane can throw on `local.pty` access, so every read goes through
  // the guard and the snapshot it maintains — see `createPtySnapshot`.
  const { safePty, snapshot: ptySnapshotOf } = createPtySnapshot(() => local)

  let backend: TerminalBackend | undefined
  // Feeds the mobile accessory row into the terminal user-input path (assigned
  // where the socket wiring is live); focus signal gates the row to the focused
  // terminal so background panes don't stack their own fixed key bars.
  let injectInput: ((data: string) => void) | undefined
  const [terminalFocused, setTerminalFocused] = createSignal(false)
  let disposed = false
  let cleaned = false
  let isBufferRestored = !props.pty.buffer
  const hasBuffer = !!(props.pty.buffer && props.pty.buffer.length > 0)
  let cursor =
    typeof local.pty.cursor === "number" && Number.isSafeInteger(local.pty.cursor) ? local.pty.cursor : 0

  const cleanups: VoidFunction[] = []

  const cleanup = () => {
    if (!cleanups.length) return
    const fns = cleanups.splice(0).reverse()
    for (const fn of fns) {
      try {
        fn()
      } catch {
        // ignore
      }
    }
  }

  // Theme handling
  const getTerminalColors = () =>
    resolveTerminalColors({
      mode: theme.mode(),
      theme: theme.themes()[theme.themeId()],
    })

  const terminalColors = createMemo(getTerminalColors)

  // Update theme when it changes
  createEffect(() => {
    const colors = terminalColors()
    backend?.setTheme(colors)
  })

  // Update font when settings change and refit so terminal cell metrics stay current.
  createEffect(() => {
    const font = monoFontFamily(settings.appearance.font())
    backend?.setFontFamily(font)
    backend?.fit()
  })

  const focusTerminal = () => {
    if (!backend) return
    backend.focus()
  }

  const refreshTerminal = (reason: string) => {
    if (!backend) return
    try {
      backend.fit()
    } catch {}
    try {
      backend.flushResize()
    } catch {}
    try {
      if (backend.rows > 0) backend.refresh(0, backend.rows - 1)
    } catch {}
  }

  let didAutoFocus = false
  createEffect(() => {
    const should = local.autoFocus !== false
    if (!should) {
      didAutoFocus = false
      return
    }
    if (!backend) return
    if (didAutoFocus) return
    didAutoFocus = true
    queueMicrotask(() => {
      if (disposed) return
      if (container.getClientRects().length === 0) return
      refreshTerminal("auto-focus")
      focusTerminal()
    })
  })

  const handlePointerDown = () => {
    const activeElement = document.activeElement
    if (
      activeElement instanceof HTMLElement &&
      activeElement !== container &&
      !container.contains(activeElement)
    ) {
      activeElement.blur()
    }
    focusTerminal()
  }

  onMount(() => {
    const run = async () => {
      // Lazy-load the xterm backend so @xterm/xterm (+addons, ~106KB gz) stays out
      // of the eager main chunk — the terminal is mounted from many layout sites.
      const { createBackend } = await import("#terminal-backend")
      const b = await createBackend(container, {
        theme: terminalColors(),
        fontFamily: monoFontFamily(settings.appearance.font()),
        image:
          /\b(?:claude|codex)\b/i.test(local.pty.initialCommand ?? "") || /\b(?:claude|codex)\b/i.test(local.pty.title)
            ? "paste"
            : "path",
        onSplitVertical: props.onSplitVertical,
        onSplitHorizontal: props.onSplitHorizontal,
        onUrlClick: (_event: MouseEvent, url: string) => {
          platform.openLink(url)
        },
        onFileLinkClick: (path: string, line?: number, col?: number, lineEnd?: number, colEnd?: number) => {
          if (props.onFileLinkOpen) {
            props.onFileLinkOpen(path, line, col, lineEnd, colEnd)
          } else if (platform.openPath) {
            void platform.openPath(path)
          }
        },
      })

      if (disposed) {
        b.dispose()
        return
      }

      backend = b
      cleanups.push(() => b.dispose())

      // Refit once OUR font is usable, so a custom mono face that resolves
      // after xterm measured its cell size doesn't leave the terminal on
      // fallback metrics (mangled glyphs until the next resize).
      //
      // `document.fonts.ready` was the wrong signal — it resolves when the
      // loads already pending settle, which can be before a face that only
      // xterm's canvas measurement requests has begun loading at all.
      scheduleFontSettleRefit({
        fontFamily: monoFontFamily(settings.appearance.font()),
        fontSize: TERMINAL_OPTIONS.fontSize,
        isAlive: () => !disposed,
        refit: () => backend?.fit(),
      })

      // Auto-focus: the createEffect-based auto-focus cannot track `backend`
      // because it's a plain variable (not a signal), so it returns early and
      // never re-fires. Focus directly after backend creation instead
      // (matches upstream's focusTerminal() call after t.open()).
      if (local.autoFocus !== false) {
        didAutoFocus = true
        queueMicrotask(() => {
          if (disposed) return
          if (container.getClientRects().length === 0) return
          refreshTerminal("auto-focus")
          focusTerminal()
        })
      }
      // Measure the mount width only once the terminal has actually been fitted
      // to its container. `b.cols` straight after creation is xterm's 80-column
      // default (fonts have not settled, no fit has run), so every cold mount
      // used to compare a real snapshot width against 80 and conclude the width
      // had changed. That drives four branches, all destructive: the
      // clear-screen on socket open, the live-tail cursor, the forced SIGWINCH
      // toggle, and restoreSize. `undefined` when the container has no usable
      // size yet — an unmeasurable width must read as "unchanged", never as
      // "changed", so an unknown never triggers a destructive path.
      const mountCols = (() => {
        try {
          b.fit()
        } catch {}
        const rect = container.getBoundingClientRect()
        if (rect.width < MIN_CONTAINER_PX || rect.height < MIN_CONTAINER_PX) return undefined
        return b.cols
      })()

      // Allow queued store updates from the previous mount cleanup to settle
      // so restore/connect use one consistent snapshot (cursor + buffer).
      await Promise.resolve()

      container.addEventListener("pointerdown", handlePointerDown)
      cleanups.push(() => container.removeEventListener("pointerdown", handlePointerDown))

      // Focus tracking for the accessory row (focusin/focusout bubble from xterm's textarea).
      const onFocusIn = () => setTerminalFocused(true)
      const onFocusOut = () => setTerminalFocused(false)
      container.addEventListener("focusin", onFocusIn)
      container.addEventListener("focusout", onFocusOut)
      cleanups.push(() => {
        container.removeEventListener("focusin", onFocusIn)
        container.removeEventListener("focusout", onFocusOut)
      })

      const snapshotCursor =
        typeof local.pty.cursor === "number" && Number.isSafeInteger(local.pty.cursor) ? local.pty.cursor : undefined
      const snapshotBuffer = local.pty.buffer
      const snapshotHasBuffer = !!(snapshotBuffer && snapshotBuffer.length > 0)
      const snapshotWasAltScreen = local.pty.wasAltScreen ?? false
      const snapshotRows = local.pty.rows
      const snapshotCols = local.pty.cols
      const snapshotWasAtBottom = local.pty.wasAtBottom
      const snapshotScrollY = local.pty.scrollY
      cursor = snapshotCursor ?? 0
      const splitWidthChanged =
        typeof mountCols === "number" &&
        typeof snapshotCols === "number" &&
        snapshotCols > 0 &&
        snapshotCols !== mountCols

      // Reload detection marker is retained for diagnostics only.
      const reloadKey = terminalReloadStorageKey(local.pty.id)
      const isReload = resolveTerminalReloadFlag(localStorage, local.pty.id)

      const persistSnapshot = (reason: string) => {
        if (!backend) return
        const buffer = (() => {
          try {
            // If a fullscreen TUI is active, persist the alternate buffer so
            // reloads can restore the screen without waiting for app output.
            const isAlt = backend.isAltScreen()
            return preparePersistBuffer(backend.serialize({ excludeAltBuffer: !isAlt, excludeModes: true }))
          } catch {
            return ""
          }
        })()
        // Modes are NOT persisted any more. The PTY host mirrors its output
        // through a headless xterm and sends a preamble built from live mode
        // state on every attach, so a renderer-side guess is both redundant and
        // (when the program it described has since exited) actively harmful.
        const wasAltScreen = (() => {
          try {
            return backend.isAltScreen()
          } catch {
            return false
          }
        })()
        const wasAtBottom = (() => {
          try {
            return backend.isAtBottom()
          } catch {
            return true
          }
        })()
        const size = { rows: backend.rows, cols: backend.cols }
        const rect = container.getBoundingClientRect()
        const saneSize = shouldSendResize(size, rect)
        props.onUpdate?.({
          id: local.pty.id,
          buffer,
          wasAltScreen,
          wasAtBottom,
          cursor,
          ...(saneSize ? size : {}),
          scrollY: backend.getViewportY(),
        })
      }

      const markReload = () => {
        // Persist a final snapshot before the document tears down. Solid cleanup
        // callbacks are not guaranteed to run on a hard reload.
        persistSnapshot("beforeunload")
        try {
          localStorage.setItem(reloadKey, "1")
        } catch {}
      }
      window.addEventListener("beforeunload", markReload)
      const handlePageHide = () => persistSnapshot("pagehide")
      window.addEventListener("pagehide", handlePageHide)
      cleanups.push(() => {
        window.removeEventListener("beforeunload", markReload)
        window.removeEventListener("pagehide", handlePageHide)
        try {
          localStorage.removeItem(reloadKey)
        } catch {}
      })

      // This PTY was created moments ago to replace one the server had lost
      // (clone recovery). Whatever the tab is NAMED, there is no TUI behind it
      // — the shell is brand new. Consume the flag now so a later remount of
      // the same, by-then-established session behaves normally again.
      const isRecreatedPty = local.pty.recreated === true
      if (isRecreatedPty) props.onUpdate?.({ id: local.pty.id, recreated: false })

      const likelyTui =
        !isRecreatedPty &&
        isLikelyTui({
          snapshotWasAltScreen: snapshotWasAltScreen === true,
          initialCommand: local.pty.initialCommand ?? "",
          title: local.pty.title ?? "",
        })

      // No renderer-side mode rehydrate any more: the PTY host sends a preamble
      // built from LIVE emulator state ahead of the replay on every attach, so
      // the modes we adopt describe the process that is actually running rather
      // than a snapshot of one that may have exited.
      const snapshotModeSequences = ""

      // Setup WebSocket connection.
      // For normal shell buffers, reconnect from live tail to avoid replaying
      // stale prompt redraw bytes during split/remount churn.
      // For TUI/alt-screen sessions, keep cursor replay so the screen can
      // recover full layout before SIGWINCH reflow.
      const plan = cursorPlan({
        likelyTui,
        splitWidthChanged,
        isReload,
        snapshotHasBuffer,
        snapshotWasAltScreen: snapshotWasAltScreen === true,
        snapshotCursor,
      })
      const hasPersistedBuffer = snapshotHasBuffer
      const useLiveTailCursor = plan.useLiveTailCursor
      const cursorStart = plan.cursorStart
      const launch = initialDelay({ likelyTui })
      const { command: initialCmd, clearStored: clearStoredInitialCmd } = resolveInitialCommand(local.pty.initialCommand)
      if (clearStoredInitialCmd) props.onUpdate?.({ id: local.pty.id, initialCommand: undefined })
      const initialReady = initialCmd ? claimInitialCommand({ id: local.pty.id, initialCommand: initialCmd }) : false
      let initialSent = false
      let gated = likelyTui && initialReady
      let gate: WebSocket | undefined
      let owner: WebSocket | undefined
      let settleTimer: ReturnType<typeof setTimeout> | undefined
      let fallbackTimer: ReturnType<typeof setTimeout> | undefined

      // --- Reconnect state ---
      // Mutable reference so all handlers (onData, publishResize) always use
      // the current socket across reconnections.
      const socketRef: { current: WebSocket | null } = { current: null }
      let reconnectAttempt = 0
      let reconnectTimer: ReturnType<typeof setTimeout> | undefined
      let reconnecting = false
      let firstConnect = true
      const once = { value: false }
      let replayReady = false

      cleanups.push(() => {
        if (initialReady && !initialSent) {
          releaseInitialCommandClaim(local.pty.id)
        }
        gate = undefined
        if (reconnectTimer) {
          clearTimeout(reconnectTimer)
          reconnectTimer = undefined
        }
        if (settleTimer) {
          clearTimeout(settleTimer)
          settleTimer = undefined
        }
        if (fallbackTimer) {
          clearTimeout(fallbackTimer)
          fallbackTimer = undefined
        }
        const sock = socketRef.current
        if (sock && (sock.readyState === WebSocket.OPEN || sock.readyState === WebSocket.CONNECTING)) {
          sock.close()
        }
      })

      const clearInitialTimers = (ws?: WebSocket) => {
        if (ws && owner !== ws) return
        if (settleTimer) {
          clearTimeout(settleTimer)
          settleTimer = undefined
        }
        if (fallbackTimer) {
          clearTimeout(fallbackTimer)
          fallbackTimer = undefined
        }
        owner = undefined
      }

      const releaseGate = (ws: WebSocket, reason: string) => {
        if (!gated || gate !== ws) return
        if (socketRef.current !== ws || ws.readyState !== WebSocket.OPEN) {
          return
        }
        gated = false
        gate = undefined
        if (!initialSent) queueInitial(ws, reason)
      }

      const sendInitial = (ws: WebSocket, _reason: string) => {
        if (!initialReady || initialSent || !initialCmd) return
        if (socketRef.current !== ws || ws.readyState !== WebSocket.OPEN) {
          return
        }
        clearInitialTimers()
        initialSent = true
        markInitialCommandRan(local.pty.id)
        ws.send(initialCmd + "\n")
        props.onUpdate?.({ id: local.pty.id, initialCommand: undefined })
      }

      const armInitial = (ws: WebSocket, reason: string) => {
        if (!initialReady || initialSent || !initialCmd) return
        owner = ws
        if (settleTimer) clearTimeout(settleTimer)
        settleTimer = setTimeout(() => {
          settleTimer = undefined
          sendInitial(ws, reason)
        }, launch.settleMs)
      }

      const armInitialFallback = (ws: WebSocket) => {
        if (!initialReady || initialSent || !initialCmd || fallbackTimer) return
        owner = ws
        fallbackTimer = setTimeout(() => {
          fallbackTimer = undefined
          sendInitial(ws, "fallback")
        }, launch.fallbackMs)
      }

      const queueInitial = (ws: WebSocket, reason: string) => {
        if (!initialReady || initialSent || !initialCmd) return
        if (owner && owner !== ws) {
          clearInitialTimers(owner)
        }
        owner = ws
        armInitialFallback(ws)
        armInitial(ws, reason)
      }

      // Single user-input path: xterm keystrokes AND the mobile accessory row
      // (Esc/Tab/Ctrl/arrows) both flow through here (same interrupt detection,
      // reply filtering, and socket send).
      const handleUserInput = (data: string) => {
        // Ctrl+C ("\x03") or bare Escape ("\x1b", length 1 — excludes escape sequences like "\x1b[A")
        if (data === "\x03" || data === "\x1b") props.onAgentInterrupt?.()

        // Shell protection: capability replies are already handled from PTY
        // output in handleMessage() via getCapabilityResponses(). If xterm
        // also surfaces OSC 10/11 replies on onData(), forwarding them here
        // makes them look like typed input and pollutes the shell prompt with
        // `rgb:...` fragments during Codex startup.
        const filtered = stripTerminalRepliesFromInput(data)
        if (!filtered) {
          return
        }
        const sock = socketRef.current
        if (sock && sock.readyState === WebSocket.OPEN) {
          sock.send(filtered)
          return
        }
      }
      // Expose the input path to the accessory row (rendered below).
      injectInput = handleUserInput

      // Wire I/O: user input → server
      cleanups.push(b.onData(handleUserInput).dispose)

      // Enter key tracking
      cleanups.push(
        b.onKey((e: { key: string }) => {
          if (e.key === "Enter") {
            props.onSubmit?.()
          }
        }).dispose,
      )

      // Debounce backend resize updates
      let backendResizeTimer: ReturnType<typeof setTimeout> | undefined
      let openResizeSettleTimer: ReturnType<typeof setTimeout> | undefined
      let pendingSize: { cols: number; rows: number } | undefined
      let suspectResizes = 0
      let lastRecoveryAt = 0
      let lastPublishedSize: { cols: number; rows: number } | undefined
      let holdResizeUntil = 0

      const publishResize = (size: { cols: number; rows: number }, source: string) => {
        const sock = socketRef.current
        if (!sock || sock.readyState !== WebSocket.OPEN) {
          return
        }
        if (source !== "desync-recovery") {
          const last = lastPublishedSize
          if (last && last.cols === size.cols && last.rows === size.rows) {
            return
          }
        }
        lastPublishedSize = size
        updatePty({ size }).catch(() => {})
      }
      const recoverDesync = () => {
        const now = Date.now()
        if (!shouldRecoverDesync({ suspect: suspectResizes, now, last: lastRecoveryAt })) return
        lastRecoveryAt = now
        suspectResizes = 0
        try {
          b.fit()
          if (b.rows > 0) b.refresh(0, b.rows - 1)
        } catch {}
        const cols = Math.max(2, b.cols)
        const rows = Math.max(2, b.rows)
        // Force SIGWINCH so TUIs reflow after transient layout corruption.
        for (const size of sigwinchToggleSize(cols, rows)) {
          publishResize(size, "desync-recovery")
        }
      }
      const scheduleOpenResize = (source: string) => {
        if (openResizeSettleTimer) clearTimeout(openResizeSettleTimer)
        openResizeSettleTimer = setTimeout(() => {
          openResizeSettleTimer = undefined
          holdResizeUntil = 0
          publishResize(pendingSize ?? { cols: b.cols, rows: b.rows }, source)
        }, OPEN_RESIZE_SETTLE_MS)
      }

      cleanups.push(
        b.onResize((size: { cols: number; rows: number }) => {
          pendingSize = size
          if (backendResizeTimer) clearTimeout(backendResizeTimer)
          backendResizeTimer = setTimeout(() => {
            if (!pendingSize) return
            const rect = container.getBoundingClientRect()
            const hostOk = hostStable(rect)
            const sizeOk = sizeSane(pendingSize, rect)
            if (!hostOk || !sizeOk || !shouldSendResize(pendingSize, rect)) {
              suspectResizes += 1
              recoverDesync()
              return
            }
            suspectResizes = 0
            if (holdResizeUntil > Date.now()) {
              scheduleOpenResize("socket-open-settled")
              return
            }
            publishResize(pendingSize, "backend-onResize")
          }, 100)
        }).dispose,
      )
      cleanups.push(() => {
        if (backendResizeTimer) clearTimeout(backendResizeTimer)
        if (openResizeSettleTimer) clearTimeout(openResizeSettleTimer)
      })

      let overload = false
      const handleOverload = (_kind: "pending" | "live", _dropped: number) => {
        if (overload) return
        overload = true
        showToast({
          variant: "error",
          title: "Terminal output overflow",
          description: "This terminal produced too much output too quickly. It has been disconnected to keep the app responsive.",
        })
        const sock = socketRef.current
        if (sock && (sock.readyState === WebSocket.OPEN || sock.readyState === WebSocket.CONNECTING)) {
          sock.close(4000, "terminal overload")
        }
      }
      const queue = createTerminalRuntimeQueue({
        maxPendingBytes: MAX_PENDING_BYTES,
        maxStreamBytes: MAX_STREAM_BYTES,
        maxBatchBytes: MAX_BATCH_BYTES,
        maxBatchItems: MAX_BATCH_ITEMS,
        maxDroppedChunks: MAX_DROPPED_CHUNKS,
        requestFrame: (cb) => window.setTimeout(cb, 0),
        cancelFrame: (id) => window.clearTimeout(id),
        // xterm write callbacks can be dropped during rapid remount/resize churn.
        // Complete synchronously so queue drain cannot deadlock on missing callbacks.
        write: (chunk, done) => {
          b.write(chunk)
          done()
        },
        onOverload: handleOverload,
        onThrottled: () => {},
      })
      cleanups.push(() => queue.dispose())

      const flushPendingMessages = () => {
        isBufferRestored = true
        queue.flushPending()
      }

      // Restore saved buffer on both tab switch and reload. The serialized buffer
      // may include the alternate buffer for fullscreen TUIs so reloads can
      // show the last screen without waiting for app output.
      // Mode sequences (DECSET/DECRST) are prepended to restore input behavior
      // (app cursor keys, mouse tracking, bracketed paste, etc.).
      const restore = prepareRestoreBuffer(snapshotBuffer)
      const bufferToRestore = restore.value
      const modeSequences = snapshotModeSequences
      const wasAltScreen = snapshotWasAltScreen

      if (bufferToRestore) {
        const size = restoreSize({
          likelyTui,
          splitWidthChanged,
          // restoreSize already falls back to backendCols for a nonsense width;
          // an unmeasured mount takes the same path.
          mountCols: mountCols ?? b.cols,
          snapshotCols,
          snapshotRows,
          backendCols: b.cols,
          backendRows: b.rows,
        })
        if (size.cols > 2 && size.rows > 0) {
          b.resize(size.cols, size.rows)
        } else {
          b.resize(80, 24)
        }

        const widthChanged = splitWidthChanged
        const shouldTrimTrailingLine = shouldTrimRestoredTail({
          isReload,
          wasAltScreen,
          snapshotWasAtBottom,
          widthChanged,
          likelyTui,
        })
        const restoreBuffer = shouldTrimTrailingLine ? trimTrailingLines(bufferToRestore, 2) : bufferToRestore

        // Restore ordering:
        // - For fullscreen TUIs: enter alt screen first, then write snapshot.
        //   This avoids a blank screen on reload when the app doesn't emit
        //   output until the next input event.
        // - For normal shells: restore modes + scrollback snapshot.
        // If a TUI leaves custom SGR attributes active (e.g. composer bg),
        // subsequent resizes can fill new rows with that background. Reset SGR
        // after snapshot restore so fit/resize uses theme defaults for new cells.
        const restoreData = buildRestoreWrite({ wasAltScreen, modeSequences, restoreBuffer, likelyTui })
        b.write(restoreData, () => {
          // Restore scroll position. Alt-screen TUIs have no scrollback
          // so the viewport starts at 0 after \x1b[?1049h — no scroll needed.
          // For normal-screen terminals, scroll to bottom (the common case)
          // unless the user had explicitly scrolled up.
          if (!wasAltScreen) {
            if (snapshotWasAtBottom !== false) {
              b.scrollToBottom()
            } else if (typeof snapshotScrollY === "number") {
              b.scrollToLine(snapshotScrollY)
            }
          }

          const stop = retry(
            () => {
              if (disposed) return true
              const rect = container.getBoundingClientRect()
              if (rect.width < 10 || rect.height < 10) return false

              try {
                b.flushResize()
                if (b.cols < 2 || b.rows < 2) return false
                return true
              } catch {
                return false
              }
            },
            {
              delay: 50,
              max: 10,
              onDone: (ok) => {
                if (disposed) return
                if (!ok) {
                  try {
                    b.resize(80, 24)
                    b.refresh(0, b.rows - 1)
                  } catch {}
                }
                flushPendingMessages()
              },
            },
          )
          cleanups.push(stop)
        })
      } else {
        isBufferRestored = true
        const stop = retry(
          () => {
            if (disposed) return true
            const rect = container.getBoundingClientRect()
            if (rect.width < 10 || rect.height < 10) return false

            try {
              b.flushResize()
              if (b.cols < 2 || b.rows < 2) return false
              return true
            } catch {
              return false
            }
          },
          {
            delay: 50,
            max: 10,
            onDone: (ok) => {
              if (disposed) return
              if (!ok) {
                try {
                  b.resize(80, 24)
                  b.refresh(0, b.rows - 1)
                } catch {}
              }
              flushPendingMessages()
            },
          },
        )
        cleanups.push(stop)
      }

      // --- Reconnectable WebSocket connection ---
      // Shared decoder persists across reconnections (no per-socket state).
      //
      // PTY output arrives as WebSocket TEXT frames today, so `event.data` is
      // already a string and this decoder only handles the 0x00-prefixed meta
      // frame. The binary branch below still decodes with `{ stream: true }`
      // so that if anything ever does deliver PTY bytes (a relay change, a
      // move to binary frames), a multi-byte codepoint straddling a frame
      // boundary is buffered rather than replaced with U+FFFD.
      const decoder = new TextDecoder()

      const scheduleReconnect = () => {
        if (disposed || overload) return
        reconnecting = true
        const delay = reconnectDelay(reconnectAttempt)
        reconnectAttempt += 1
        try {
          b.write(reconnectingMessage(reconnectAttempt, MAX_RECONNECT_ATTEMPTS))
        } catch {}
        reconnectTimer = setTimeout(() => {
          reconnectTimer = undefined
          if (disposed) return
          void connectSocket()
        }, delay)
      }

      const connectSocket = async () => {
        if (disposed || overload) return

        // Build URL with live cursor on reconnect, or planned cursor on first connect.
        const cursorParamValue = firstConnect ? plan.cursorParam : cursor
        firstConnect = false

        // Close previous socket if still lingering
        const prev = socketRef.current
        if (prev && (prev.readyState === WebSocket.OPEN || prev.readyState === WebSocket.CONNECTING)) {
          try { prev.close() } catch {}
        }

        const ws = await openTerminalWebSocket({
          serverUrl: claxedoServerUrl,
          ptyId: local.pty.id,
          cursor: cursorParamValue,
          workspaceId: await terminalWorkspaceId(),
          directory: sdk.directory,
          request: ptyRequest,
          locationProtocol: window.location.protocol,
        })
        ws.binaryType = "arraybuffer"
        socketRef.current = ws
        once.value = false
        replayReady = false

        if (disposed) {
          ws.close()
          return
        }

        // Per-socket cleanup (removed from main cleanups when socket is replaced)
        const socketCleanups: VoidFunction[] = []
        const cleanupSocket = () => {
          for (const fn of socketCleanups.splice(0).reverse()) {
            try { fn() } catch {}
          }
        }
        cleanups.push(cleanupSocket)
        socketCleanups.push(() => {
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close()
          }
        })

        // --- handleOpen ---
        const wasReconnect = reconnecting
        const handleOpen = () => {
          reconnecting = false
          reconnectAttempt = 0

          if (wasReconnect) {
            try { b.write(reconnectedMessage()) } catch {}
          }

          local.onConnect?.()

          // For fullscreen-ish TUIs that run in the normal buffer (Ink/Codex),
          // ensure resizes don't inherit whatever SGR the app last used.
          if (likelyTui && (splitWidthChanged || isReload || wasReconnect)) {
            try {
              b.write("\x1b[0m")
            } catch {}
          }

          // Fit first: after buffer restore, b.cols/rows may still reflect saved
          // dimensions from b.resize(savedCols, savedRows).
          try {
            b.fit()
          } catch {}
          // Only force SIGWINCH double-toggle for TUI apps (likelyTui).
          // Plain shells (zsh/bash) only need a single resize via scheduleOpenResize —
          // the double-toggle causes ZSH to redraw mid-query, emitting CPR / OSC color
          // responses that arrive back as echoed garbage in the prompt.
          // Note: wasReconnect used to implicitly be false here because trim() caused a
          // remount (resetting reconnecting=false). Now that trim() no longer remounts,
          // we must explicitly exclude plain terminals from the forced SIGWINCH path.
          const shouldForceSigwinch = likelyTui
          if (!shouldForceSigwinch) {
            holdResizeUntil = Date.now() + OPEN_RESIZE_SETTLE_MS
            scheduleOpenResize("socket-open")
            releaseGate(ws, "socket-open")
          } else {
            gate = gated ? ws : undefined
            holdResizeUntil = 0
            if (openResizeSettleTimer) {
              clearTimeout(openResizeSettleTimer)
              openResizeSettleTimer = undefined
            }
            if (splitWidthChanged || wasReconnect) {
              try {
                b.write("\x1b[0m\x1b[H\x1b[2J")
              } catch {}
            }
            // Force SIGWINCH via resize toggle so TUI apps re-render after reconnect.
            const targetCols = b.cols
            const targetRows = b.rows
            const [first, second] = sigwinchToggleSize(targetCols, targetRows)
            updatePty({ size: first })
              .then(() => {
                return updatePty({ size: second })
              })
              .then(() => {
                releaseGate(ws, "sigwinch")
              })
              .catch(() => {
                releaseGate(ws, "sigwinch-failed")
              })
          }

          // Execute initial command only once per PTY, including across reloads.
          // Wait for shell output to settle instead of firing blindly after a
          // fixed delay. This avoids racing shell startup on fresh PTYs.
          if (gated) {
            armInitialFallback(ws)
          }
          if (!gated && !initialSent) {
            queueInitial(ws, wasReconnect ? "reconnect-open" : "socket-open")
          }
        }
        ws.addEventListener("open", handleOpen)
        socketCleanups.push(() => ws.removeEventListener("open", handleOpen))
        socketCleanups.push(() => {
          if (gate === ws) gate = undefined
        })
        socketCleanups.push(() => clearInitialTimers(ws))

        // --- handleMessage ---
        const handleMessage = (event: MessageEvent) => {
          if (disposed) return
          let data = ""
          if (event.data instanceof ArrayBuffer) {
            // WebSocket control frame: 0x00 + UTF-8 JSON (currently { cursor }).
            const bytes = new Uint8Array(event.data)
            if (bytes[0] === 0) {
              // Meta frames are self-contained: decode without `stream` so a
              // truncated one can't poison the decoder's carry state for the
              // PTY-data path below.
              const json = new TextDecoder().decode(bytes.subarray(1))
              try {
                const meta = JSON.parse(json) as { cursor?: unknown }
                const next = meta?.cursor
                if (typeof next === "number" && Number.isSafeInteger(next) && next >= 0) {
                  replayReady = true
                  cursor = next
                  return
                }
              } catch {
                // ignore
              }
              return
            }
            data = decoder.decode(bytes, { stream: true })
          } else {
            data = typeof event.data === "string" ? event.data : ""
          }

          if (!data) {
            return
          }
          if (!gated && !initialSent) {
            queueInitial(ws, "output-settled")
          }
          // The cursor is an INDEX INTO THE SERVER'S UTF-16 STRING BUFFER — the
          // server advances it by `data.length` and `connect()` feeds it
          // straight into `String.slice`. Counting UTF-8 bytes here instead
          // drifted the client strictly ahead of the server on any non-ASCII
          // output (UTF-8 bytes >= UTF-16 units), so on reconnect the server
          // saw `from >= end` and replayed NOTHING — output produced while
          // disconnected was dropped silently. Count the same units the server
          // does; the string here is byte-identical to the one it sent.
          cursor += data.length
          // Respond to terminal capability queries immediately, before any queuing.
          // TUI apps (e.g. codex) query the terminal at startup and time out
          // after ~2s per query group if no responses arrive. We respond here
          // unconditionally so the PTY gets the answers now regardless of
          // whether buffer restoration is in progress. Messages still queue
          // for rendering as normal.
          const capabilityResponses = getCapabilityResponses(data)
          if (capabilityResponses.length > 0 && replayReady) {
            const responseSock = socketRef.current
            if (responseSock && responseSock.readyState === WebSocket.OPEN) {
              for (const r of capabilityResponses) {
                responseSock.send(r)
              }
            }
          }
          const next = data
          // Queue messages if buffer restoration is still in progress
          if (!isBufferRestored) {
            queue.push(next)
            return
          }
          b.write(next)
        }
        ws.addEventListener("message", handleMessage)
        socketCleanups.push(() => ws.removeEventListener("message", handleMessage))

        // --- handleError ---
        const handleError = () => {
          if (disposed) return
          // Don't call onConnectError here — let handleClose decide whether
          // to retry or give up. WebSocket error is always followed by close.
        }
        ws.addEventListener("error", handleError)
        socketCleanups.push(() => ws.removeEventListener("error", handleError))

        // --- handleClose ---
        const handleClose = (event: CloseEvent) => {
          if (disposed) return

          const action = classifyTerminalClose({
            code: event.code,
            reconnectAttempt,
            maxAttempts: MAX_RECONNECT_ATTEMPTS,
          })
          switch (action.kind) {
            // Normal close (1000) or non-error — do nothing
            case "ignore":
              return
            // Session not found (1008) — PTY is gone, delegate to clone-on-reconnect
            case "session-gone":
              if (once.value) return
              once.value = true
              local.onConnectError?.(new WebSocketCloseError(event.code, event.reason))
              return
            // Retriable error under the limit — schedule reconnect
            case "reconnect":
              cleanupSocket()
              scheduleReconnect()
              return
            // Exhausted retries or non-retriable code
            case "fail":
              if (once.value) return
              once.value = true
              if (action.exhausted) {
                try { b.write(reconnectFailedMessage()) } catch {}
              }
              local.onConnectError?.(new WebSocketCloseError(event.code, event.reason))
              return
          }
        }
        ws.addEventListener("close", handleClose)
        socketCleanups.push(() => ws.removeEventListener("close", handleClose))
      }

      // Initial connection
      await connectSocket()

    }

    void run().catch((err) => {
      if (disposed) return
      showToast({
        variant: "error",
        title: language.t("terminal.connectionLost.title"),
        description: err instanceof Error ? err.message : language.t("terminal.connectionLost.description"),
      })
      local.onConnectError?.(err)
    })
  })

  onCleanup(() => {
    if (cleaned) return
    cleaned = true
    disposed = true

    // Serialize state for restoration
    const pty = (() => {
      const live = safePty()
      if (live) return live
      return ptySnapshotOf()
    })()
    if (backend && props.onCleanup && pty) {
      const buffer = (() => {
        try {
          const isAlt = backend.isAltScreen()
          return preparePersistBuffer(backend.serialize({ excludeAltBuffer: !isAlt, excludeModes: true }))
        } catch {
          return ""
        }
      })()
      const modeSequences = (() => {
        try {
          return backend.rehydrateSequences()
        } catch {
          return ""
        }
      })()
      const wasAltScreen = (() => {
        try {
          return backend.isAltScreen()
        } catch {
          return false
        }
      })()
      const wasAtBottom = (() => {
        try {
          return backend.isAtBottom()
        } catch {
          return true
        }
      })()
      props.onCleanup({
        ...pty,
        buffer,
        modeSequences,
        wasAltScreen,
        wasAtBottom,
        cursor,
        rows: backend.rows,
        cols: backend.cols,
        scrollY: backend.getViewportY(),
      })
    }

    // Defer backend/xterm disposal so Solid can finish its own DOM teardown first.
    // Disposing xterm synchronously during cleanNode can race with node removal.
    queueMicrotask(() => cleanup())
  })

  return (
    <>
      <div
        ref={container}
        data-component="terminal"
        data-prevent-autofocus
        tabIndex={-1}
        style={{ "background-color": terminalColors().background }}
        classList={{
          ...(local.classList ?? {}),
          "select-text": true,
          "h-full w-full overflow-hidden font-mono": true,
          [local.class ?? ""]: !!local.class,
        }}
        {...others}
      />
      {/* Mobile soft-keyboard accessory bar — coarse-pointer/narrow only (hidden on desktop). */}
      <TerminalAccessoryRow onKey={(data) => injectInput?.(data)} active={terminalFocused} />
    </>
  )
}
