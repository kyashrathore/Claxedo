import type { TerminalBackend } from "../terminal/backend/types"
import { createBackend } from "#terminal-backend"
import { retry } from "../terminal/retry"
import { ComponentProps, createEffect, createMemo, onCleanup, onMount, splitProps } from "solid-js"
import { useSDK } from "@/context/sdk"
import { monoFontFamily, useSettings } from "@/context/settings"
import { LocalPTY } from "@/context/terminal"
import { usePlatform } from "@/context/platform"
import { resolveThemeVariant, useTheme, withAlpha, type HexColor } from "@opencode-ai/ui/theme"
import { useLanguage } from "@/context/language"
import { showToast } from "@opencode-ai/ui/toast"
import { claimInitialCommand, markInitialCommandRan, releaseInitialCommandClaim } from "./terminal-recovery"
import { preparePersistBuffer, prepareRestoreBuffer } from "./terminal-buffer"
import { hostStable, shouldRecoverDesync, shouldSendResize, sizeSane } from "./terminal-geometry"
import {
  sigwinchToggleSize,
  socketCloseIsError,
  WebSocketCloseError,
  isRetriableClose,
  reconnectDelay,
  MAX_RECONNECT_ATTEMPTS,
  reconnectingMessage,
  reconnectedMessage,
  reconnectFailedMessage,
} from "./terminal-connection"
import { createTerminalRuntimeQueue } from "./terminal-runtime-queue"
import { cursorPlan, filterModeSequences, initialDelay, isLikelyTui, restoreSize } from "./terminal-tui"
import { stripTerminalRepliesFromInput } from "../terminal/input-reply-filter"
import { getCapabilityResponses } from "../terminal/capability-responder"
import { getClaxedoServerUrl } from "../../utils/api"

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
  onFileLinkOpen?: (path: string, line?: number, col?: number) => void
}

type TerminalColors = {
  background: string
  foreground: string
  cursor: string
  selectionBackground: string
}

const DEFAULT_TERMINAL_COLORS: Record<"light" | "dark", TerminalColors> = {
  light: {
    background: "#fcfcfc",
    foreground: "#211e1e",
    cursor: "#211e1e",
    selectionBackground: withAlpha("#211e1e", 0.2),
  },
  dark: {
    background: "#191515",
    foreground: "#d4d4d4",
    cursor: "#d4d4d4",
    selectionBackground: withAlpha("#d4d4d4", 0.25),
  },
}

// Tuned for vtebench full profile (ramp stage 6: 1 MiB samples, max-secs=10,
// max-samples=200) so heavy TUI output can complete without early throttling.
// Baseline from stage 6 validation:
// dense_cells 11.55ms, medium_cells 10.72ms, scrolling 18.02ms,
// scrolling_bottom_region 17.95ms, scrolling_bottom_small_region 18.05ms,
// scrolling_fullscreen 23.53ms, scrolling_top_region 18.22ms,
// scrolling_top_small_region 18.04ms, sync_medium_cells 11.75ms, unicode 9.18ms.
const MAX_PENDING_BYTES = 128 * 1024 * 1024
const MAX_STREAM_BYTES = 128 * 1024 * 1024
const MAX_BATCH_BYTES = 4 * 1024 * 1024
const MAX_BATCH_ITEMS = 8192
const MAX_DROPPED_CHUNKS = 1_000_000
const OPEN_RESIZE_SETTLE_MS = 220

let mountCounter = 0

export const Terminal = (props: TerminalProps) => {
  const sdk = useSDK()
  // CLAXEDO: PTYs live on claxedo-server — route WebSocket and size sync there
  const claxedoServerUrl = getClaxedoServerUrl()
  const settings = useSettings()
  const theme = useTheme()
  const language = useLanguage()
  const platform = usePlatform()

  let container!: HTMLDivElement
  const [local, others] = splitProps(props, ["pty", "autoFocus", "class", "classList", "onConnect", "onConnectError"])
  const safePty = () => {
    try {
      return local.pty
    } catch {
      return
    }
  }
  let ptySnapshot = (() => {
    const pty = safePty()
    if (!pty) return
    return { ...pty }
  })()
  createEffect(() => {
    const pty = safePty()
    if (!pty) return
    ptySnapshot = { ...pty }
  })

  let backend: TerminalBackend | undefined
  let disposed = false
  let cleaned = false
  let isBufferRestored = !props.pty.buffer
  let msgCount = 0
  const hasBuffer = !!(props.pty.buffer && props.pty.buffer.length > 0)
  let cursor =
    typeof local.pty.cursor === "number" && Number.isSafeInteger(local.pty.cursor) ? local.pty.cursor : 0
  const mountId = ++mountCounter
  const resizeBySource: Record<string, number> = {}
  const stats = {
    resizeEvent: 0,
    resizeRejected: 0,
    resizePublishAttempt: 0,
    resizePublishSkip: 0,
    resizePublishAck: 0,
    textFrames: 0,
    textBytes: 0,
    metaFrames: 0,
    metaCursor: 0,
    metaInvalid: 0,
    binaryIgnored: 0,
    emptyFrames: 0,
    inputEvents: 0,
    inputBytes: 0,
    initialCheckTrue: 0,
    initialCheckFalse: 0,
    initialSent: 0,
  }

  const timing = {
    mountAt: 0,
    backendReadyAt: 0,
    socketConnectAt: 0,
    socketOpenAt: 0,
    firstTextByteAt: 0,
  }

  const cleanups: VoidFunction[] = []
  const isDebug = () => false
  const isVerbose = () => false
  const trace = (..._args: unknown[]) => {}
  const traceVerbose = (..._args: unknown[]) => {}
  const oneLine = (value: string) =>
    value
      .replaceAll("\r", "\\r")
      .replaceAll("\n", "\\n")
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "<esc>")
      .slice(0, 120)
  const trimTrailingLines = (value: string, count: number) => {
    let out = value
    let left = count
    while (left > 0) {
      const idx = Math.max(out.lastIndexOf("\n"), out.lastIndexOf("\r"))
      if (idx < 0) return ""
      out = out.slice(0, idx + 1)
      left -= 1
    }
    return out
  }
  const markResizeSource = (source: string) => {
    resizeBySource[source] = (resizeBySource[source] ?? 0) + 1
  }
  const num = (value: number) => Math.round(value * 10) / 10
  const host = () => {
    if (!container) return
    const rect = container.getBoundingClientRect()
    return {
      clientWidth: num(container.clientWidth),
      clientHeight: num(container.clientHeight),
      rectWidth: num(rect.width),
      rectHeight: num(rect.height),
      offsetWidth: num(container.offsetWidth),
      offsetHeight: num(container.offsetHeight),
      visible: container.getClientRects().length > 0,
    }
  }

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
  const getTerminalColors = (): TerminalColors => {
    const mode = theme.mode()
    const fallback = DEFAULT_TERMINAL_COLORS[mode]
    const currentTheme = theme.themes()[theme.themeId()]
    if (!currentTheme) return fallback
    const variant = mode === "dark" ? currentTheme.dark : currentTheme.light
    if (!variant?.seeds && !variant?.palette) return fallback
    const resolved = resolveThemeVariant(variant, mode === "dark")
    const text = resolved["text-stronger"] ?? fallback.foreground
    const background = resolved["background-stronger"] ?? fallback.background
    const alpha = mode === "dark" ? 0.25 : 0.2
    const base = text.startsWith("#") ? (text as HexColor) : (fallback.foreground as HexColor)
    const selectionBackground = withAlpha(base, alpha)
    return {
      background,
      foreground: text,
      cursor: text,
      selectionBackground,
    }
  }

  const terminalColors = createMemo(getTerminalColors)

  // Update theme when it changes
  createEffect(() => {
    const colors = terminalColors()
    backend?.setTheme(colors)
  })

  // Update font when settings change and refit so ghostty re-measures cell widths
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
    traceVerbose("activation refresh", {
      reason,
      backendCols: backend.cols,
      backendRows: backend.rows,
      host: host(),
    })
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
    timing.mountAt = performance.now()

    trace("mount", {
      dir: sdk.directory,
      hasBuffer: !!props.pty.buffer,
      start: typeof local.pty.cursor === "number" && Number.isSafeInteger(local.pty.cursor) ? local.pty.cursor : undefined,
      cursor,
    })

    const run = async () => {
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
        onFileLinkClick: (path: string, line?: number, col?: number) => {
          if (props.onFileLinkOpen) {
            props.onFileLinkOpen(path, line, col)
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

      // Refit after all fonts load — ghostty-web measures cell widths on open;
      // if the custom mono font isn't ready yet it uses fallback metrics and
      // gets permanently wrong character spacing. This mirrors upstream's fix.
      if (typeof document !== "undefined" && document.fonts) {
        document.fonts.ready.then(() => {
          if (!disposed) backend?.fit()
        })
      }

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
      const mountCols = b.cols
      timing.backendReadyAt = performance.now()
      trace("backend ready", { backendCols: b.cols, backendRows: b.rows, host: host(), backendMs: Math.round(timing.backendReadyAt - timing.mountAt) })

      // Allow queued store updates from the previous mount cleanup to settle
      // so restore/connect use one consistent snapshot (cursor + buffer).
      await Promise.resolve()

      container.addEventListener("pointerdown", handlePointerDown)
      cleanups.push(() => container.removeEventListener("pointerdown", handlePointerDown))

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
      const splitWidthChanged = typeof snapshotCols === "number" && snapshotCols > 0 && snapshotCols !== mountCols

      // Reload detection marker is retained for diagnostics only.
      const reloadKey = `opencode.pty.${local.pty.id}.reload`
      const isReload = !!localStorage.getItem(reloadKey)
      try {
        localStorage.removeItem(reloadKey)
      } catch {}

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
        props.onUpdate?.({
          id: local.pty.id,
          buffer,
          modeSequences,
          wasAltScreen,
          wasAtBottom,
          cursor,
          rows: backend.rows,
          cols: backend.cols,
          scrollY: backend.getViewportY(),
        })
        traceVerbose("snapshot persisted", { reason, len: buffer.length, cursor })
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

      const likelyTui = isLikelyTui({
        snapshotWasAltScreen: snapshotWasAltScreen === true,
        initialCommand: local.pty.initialCommand ?? "",
        title: local.pty.title ?? "",
      })

      // Never restore alternate-screen toggles from mode rehydrate (snapshot
      // buffer restore handles alt-screen). For non-TUIs, strip mouse/focus
      // reporting to avoid accidental SGR mouse "gibberish" in shells.
      const snapshotModeSequences = filterModeSequences({
        raw: local.pty.modeSequences ?? "",
        likelyTui,
      })

      if (isVerbose()) {
        traceVerbose("snapshot", {
          isReload,
          splitWidthChanged,
          likelyTui,
          snapshotWasAltScreen,
          snapshotHasBuffer,
          snapshotCols,
          snapshotRows,
          mountCols,
          cursor: snapshotCursor,
        })
      }

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
      const initialCmd = local.pty.initialCommand ?? ""
      const initialReady = claimInitialCommand(local.pty)
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
          trace("initial gate waiting", {
            reason,
            socketReadyState: ws.readyState,
            current: socketRef.current === ws,
          })
          return
        }
        gated = false
        gate = undefined
        trace("initial gate released", { reason })
        if (!initialSent) queueInitial(ws, reason)
      }

      const sendInitial = (ws: WebSocket, reason: string) => {
        if (!initialReady || initialSent || !initialCmd) return
        if (socketRef.current !== ws || ws.readyState !== WebSocket.OPEN) {
          trace("initial command waiting", {
            reason,
            socketReadyState: ws.readyState,
            current: socketRef.current === ws,
          })
          return
        }
        clearInitialTimers()
        initialSent = true
        stats.initialSent += 1
        markInitialCommandRan(local.pty.id)
        trace("initial command sent", {
          reason,
          len: initialCmd.length,
          initialSent: stats.initialSent,
          sample: oneLine(initialCmd),
        })
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

      const queueInitial = (ws: WebSocket, reason: string) => {
        if (!initialReady || initialSent || !initialCmd) return
        if (owner && owner !== ws) {
          clearInitialTimers(owner)
        }
        owner = ws
        if (!fallbackTimer) {
          fallbackTimer = setTimeout(() => {
            fallbackTimer = undefined
            sendInitial(ws, "fallback")
          }, launch.fallbackMs)
        }
        armInitial(ws, reason)
      }

      // Wire I/O: user input → server
      cleanups.push(
        b.onData((data: string) => {
          // Ctrl+C ("\x03") or bare Escape ("\x1b", length 1 — excludes escape sequences like "\x1b[A")
          if (data === "\x03" || data === "\x1b") props.onAgentInterrupt?.()

          stats.inputEvents += 1
          stats.inputBytes += data.length
          // Shell protection: capability replies are already handled from PTY
          // output in handleMessage() via getCapabilityResponses(). If xterm
          // also surfaces OSC 10/11 replies on onData(), forwarding them here
          // makes them look like typed input and pollutes the shell prompt with
          // `rgb:...` fragments during Codex startup.
          const filtered = stripTerminalRepliesFromInput(data)
          const sock = socketRef.current
          if (isVerbose() && (stats.inputEvents <= 5 || stats.inputEvents % 20 === 0)) {
            traceVerbose("onData", {
              event: stats.inputEvents,
              bytes: data.length,
              sample: oneLine(data),
              filteredBytes: filtered.length,
              filteredSample: oneLine(filtered),
              socketReadyState: sock?.readyState,
            })
          }
          if (!filtered) {
            traceVerbose("input suppressed", {
              event: stats.inputEvents,
              bytes: data.length,
              sample: oneLine(data),
            })
            return
          }
          if (sock && sock.readyState === WebSocket.OPEN) {
            sock.send(filtered)
            return
          }
          trace("input dropped", {
            event: stats.inputEvents,
            bytes: filtered.length,
            socketReadyState: sock?.readyState,
          })
        }).dispose,
      )

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
        stats.resizePublishAttempt += 1
        markResizeSource(source)
        const sock = socketRef.current
        const snapshot = {
          mountId,
          source,
          size,
          host: host(),
          backendCols: b.cols,
          backendRows: b.rows,
          socketReadyState: sock?.readyState,
          resizePublishAttempt: stats.resizePublishAttempt,
        }
        if (!sock || sock.readyState !== WebSocket.OPEN) {
          stats.resizePublishSkip += 1
          trace("resize publish skipped", { ...snapshot, resizePublishSkip: stats.resizePublishSkip })
          return
        }
        if (source !== "desync-recovery") {
          const last = lastPublishedSize
          if (last && last.cols === size.cols && last.rows === size.rows) {
            stats.resizePublishSkip += 1
            traceVerbose("resize publish dedup", { ...snapshot, resizePublishSkip: stats.resizePublishSkip })
            return
          }
        }
        lastPublishedSize = size
        trace("resize publish", snapshot)
        fetch(`${claxedoServerUrl}/api/claxedo/pty/${local.pty.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ size }),
        })
          .then(() => {
            stats.resizePublishAck += 1
            traceVerbose("resize ack", { ...snapshot, resizePublishAck: stats.resizePublishAck })
          })
          .catch((error) => {
            trace("resize publish failed", {
              ...snapshot,
              error: error instanceof Error ? error.message : String(error),
            })
          })
      }
      const recoverDesync = () => {
        const now = Date.now()
        if (!shouldRecoverDesync({ suspect: suspectResizes, now, last: lastRecoveryAt })) return
        lastRecoveryAt = now
        suspectResizes = 0
        trace("desync recovery", { cols: b.cols, rows: b.rows })
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
          stats.resizeEvent += 1
          if (isVerbose() && (stats.resizeEvent <= 8 || stats.resizeEvent % 25 === 0)) {
            traceVerbose("onResize event", {
              event: stats.resizeEvent,
              size,
              host: host(),
              backendCols: b.cols,
              backendRows: b.rows,
            })
          }
          pendingSize = size
          if (backendResizeTimer) clearTimeout(backendResizeTimer)
          backendResizeTimer = setTimeout(() => {
            if (!pendingSize) return
            const rect = container.getBoundingClientRect()
            const hostOk = hostStable(rect)
            const sizeOk = sizeSane(pendingSize, rect)
            if (!hostOk || !sizeOk || !shouldSendResize(pendingSize, rect)) {
              suspectResizes += 1
              stats.resizeRejected += 1
              if (isDebug()) {
                trace("resize rejected", {
                  pendingSize,
                  rect: { width: num(rect.width), height: num(rect.height) },
                  hostOk,
                  sizeOk,
                  suspectResizes,
                  resizeRejected: stats.resizeRejected,
                  backendCols: b.cols,
                  backendRows: b.rows,
                })
              }
              recoverDesync()
              return
            }
            suspectResizes = 0
            if (isVerbose()) {
              traceVerbose("resize accepted", {
                pendingSize,
                rect: { width: num(rect.width), height: num(rect.height) },
                backendCols: b.cols,
                backendRows: b.rows,
              })
            }
            if (holdResizeUntil > Date.now()) {
              traceVerbose("resize held during open settle", {
                pendingSize,
                holdMs: holdResizeUntil - Date.now(),
              })
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

      if (isDebug()) {
        trace("restore", {
          isReload,
          hasBuffer: !!bufferToRestore,
          len: bufferToRestore?.length ?? 0,
          trimmed: restore.trimmed,
          hasModes: modeSequences.length > 0,
          wasAltScreen,
        })
      }

      if (bufferToRestore) {
        const size = restoreSize({
          likelyTui,
          splitWidthChanged,
          mountCols,
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
        const shouldTrimTrailingLine =
          !isReload &&
          !wasAltScreen &&
          snapshotWasAtBottom !== false &&
          widthChanged &&
          !likelyTui
        const restoreBuffer = shouldTrimTrailingLine ? trimTrailingLines(bufferToRestore, 2) : bufferToRestore

        // Restore ordering:
        // - For fullscreen TUIs: enter alt screen first, then write snapshot.
        //   This avoids a blank screen on reload when the app doesn't emit
        //   output until the next input event.
        // - For normal shells: restore modes + scrollback snapshot.
        // If a TUI leaves custom SGR attributes active (e.g. composer bg),
        // subsequent resizes can fill new rows with that background. Reset SGR
        // after snapshot restore so fit/resize uses theme defaults for new cells.
        const restoreTail = likelyTui ? "\x1b[0m" : ""
        const restoreData = wasAltScreen
          ? `\x1b[?1049h${modeSequences}${restoreBuffer}${restoreTail}`
          : `${modeSequences}${restoreBuffer}${restoreTail}`
        if (shouldTrimTrailingLine && isDebug()) {
          trace("restore trimmed trailing line", {
            originalLen: bufferToRestore.length,
            nextLen: restoreBuffer.length,
            linesTrimmed: 2,
            snapshotCols,
            mountCols,
            backendCols: b.cols,
          })
        }
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
              if (isVerbose()) {
                traceVerbose("restore retry", {
                  phase: "with-buffer",
                  rect: { width: num(rect.width), height: num(rect.height) },
                  backendCols: b.cols,
                  backendRows: b.rows,
                })
              }
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
                if (isDebug()) {
                  trace("restore retry complete", {
                    phase: "with-buffer",
                    ok,
                    host: host(),
                    backendCols: b.cols,
                    backendRows: b.rows,
                  })
                }
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
            if (isVerbose()) {
              traceVerbose("restore retry", {
                phase: "without-buffer",
                rect: { width: num(rect.width), height: num(rect.height) },
                backendCols: b.cols,
                backendRows: b.rows,
              })
            }
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
              if (isDebug()) {
                trace("restore retry complete", {
                  phase: "without-buffer",
                  ok,
                  host: host(),
                  backendCols: b.cols,
                  backendRows: b.rows,
                })
              }
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
      // Shared decoders persist across reconnections (no per-socket state).
      const decoder = new TextDecoder()
      const encoder = new TextEncoder()

      const scheduleReconnect = () => {
        if (disposed || overload) return
        reconnecting = true
        const delay = reconnectDelay(reconnectAttempt)
        reconnectAttempt += 1
        trace("scheduling reconnect", { attempt: reconnectAttempt, delay })
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
        // CLAXEDO: PTYs live on claxedo-server; no directory param or auth needed
        const cursorParam = `?cursor=${cursorParamValue}`

        const urlString = claxedoServerUrl + `/api/claxedo/pty/${local.pty.id}/connect${cursorParam}`

        const url = new URL(urlString)
        if (url.protocol === "http:") url.protocol = "ws:"
        if (url.protocol === "https:") url.protocol = "wss:"
        if (url.protocol !== "ws:" && url.protocol !== "wss:") {
          url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
        }

        // Close previous socket if still lingering
        const prev = socketRef.current
        if (prev && (prev.readyState === WebSocket.OPEN || prev.readyState === WebSocket.CONNECTING)) {
          try { prev.close() } catch {}
        }

        const ws = new WebSocket(url)
        ws.binaryType = "arraybuffer"
        socketRef.current = ws
        once.value = false
        replayReady = false

        timing.socketConnectAt = performance.now()
        trace("socket connecting", {
          url: url.toString(),
          cursor: cursorParamValue,
          reconnectAttempt,
          sinceMount: Math.round(timing.socketConnectAt - timing.mountAt),
        })

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
          timing.socketOpenAt = performance.now()
          reconnecting = false
          reconnectAttempt = 0

          trace("socket open", {
            cols: b.cols,
            rows: b.rows,
            wasReconnect,
            wsHandshakeMs: Math.round(timing.socketOpenAt - timing.socketConnectAt),
            sinceMountMs: Math.round(timing.socketOpenAt - timing.mountAt),
          })

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
            traceVerbose("pre-fit sgr reset", { splitWidthChanged, isReload, wasReconnect })
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
              traceVerbose("sigwinch preclear", { cols: b.cols, rows: b.rows, splitWidthChanged, wasReconnect })
            }
            // Force SIGWINCH via resize toggle so TUI apps re-render after reconnect.
            const targetCols = b.cols
            const targetRows = b.rows
            const [first, second] = sigwinchToggleSize(targetCols, targetRows)
            if (isDebug()) {
              trace("socket open sigwinch", {
                target: { cols: targetCols, rows: targetRows },
                first,
                second,
                host: host(),
                wasAltScreen: snapshotWasAltScreen === true,
                likelyTui,
                wasReconnect,
              })
            }
            fetch(`${claxedoServerUrl}/api/claxedo/pty/${local.pty.id}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ size: first }),
            })
              .then(() => {
                traceVerbose("sigwinch ack", { size: first, step: 1 })
                return fetch(`${claxedoServerUrl}/api/claxedo/pty/${local.pty.id}`, {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ size: second }),
                })
              })
              .then(() => {
                traceVerbose("sigwinch ack", { size: second, step: 2 })
                releaseGate(ws, "sigwinch")
              })
              .catch((error) => {
                trace("socket open sigwinch failed", { first, second, error: error instanceof Error ? error.message : String(error) })
                releaseGate(ws, "sigwinch-failed")
              })
          }

          // Execute initial command only once per PTY, including across reloads.
          // Wait for shell output to settle instead of firing blindly after a
          // fixed delay. This avoids racing shell startup on fresh PTYs.
          if (!wasReconnect) {
            if (initialReady) stats.initialCheckTrue += 1
            else stats.initialCheckFalse += 1
            trace("initial command decision", {
              runInitial: initialReady,
              hasInitialCommand: !!local.pty.initialCommand,
              initialLen: local.pty.initialCommand?.length,
            })
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
          if (event.data instanceof ArrayBuffer) {
            stats.metaFrames += 1
            // WebSocket control frame: 0x00 + UTF-8 JSON (currently { cursor }).
            const bytes = new Uint8Array(event.data)
            if (bytes[0] !== 0) {
              stats.binaryIgnored += 1
              if (isVerbose() && (stats.binaryIgnored <= 5 || stats.binaryIgnored % 20 === 0)) {
                traceVerbose("binary frame ignored", { count: stats.binaryIgnored, byteLength: bytes.length, first: bytes[0] })
              }
              return
            }
            const json = decoder.decode(bytes.subarray(1))
            try {
              const meta = JSON.parse(json) as { cursor?: unknown }
              const next = meta?.cursor
              if (typeof next === "number" && Number.isSafeInteger(next) && next >= 0) {
                stats.metaCursor += 1
                replayReady = true
                if (isVerbose() && (stats.metaCursor <= 5 || stats.metaCursor % 20 === 0)) {
                  traceVerbose("cursor meta", { before: cursor, next, count: stats.metaCursor, replayReady })
                }
                cursor = next
                return
              }
              stats.metaInvalid += 1
              trace("cursor meta ignored", { cursor: meta?.cursor, count: stats.metaInvalid })
            } catch {
              stats.metaInvalid += 1
              trace("cursor meta parse failed", { count: stats.metaInvalid, byteLength: bytes.length })
            }
            return
          }

          const data = typeof event.data === "string" ? event.data : ""
          if (!data) {
            stats.emptyFrames += 1
            return
          }
          if (!gated && !initialSent) {
            queueInitial(ws, "output-settled")
          }
          const dataBytes = encoder.encode(data).byteLength
          stats.textFrames += 1
          stats.textBytes += dataBytes
          cursor += dataBytes
          if (timing.firstTextByteAt === 0 && dataBytes > 0) {
            timing.firstTextByteAt = performance.now()
          }
          msgCount += 1
          if (isVerbose() && (msgCount <= 5 || msgCount % 50 === 0)) {
            traceVerbose("socket message", {
              index: msgCount,
              bytes: dataBytes,
              textFrames: stats.textFrames,
              textBytes: stats.textBytes,
              restored: isBufferRestored,
              sample: oneLine(data),
            })
          }
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
              trace("capability fast response", { ptyId: local.pty.id, restored: isBufferRestored, count: capabilityResponses.length })
            }
          } else if (capabilityResponses.length > 0) {
            trace("capability response skipped during replay", {
              ptyId: local.pty.id,
              restored: isBufferRestored,
              replayReady,
              count: capabilityResponses.length,
              sample: oneLine(data),
            })
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
          trace("socket error", { reconnecting, reconnectAttempt })
          // Don't call onConnectError here — let handleClose decide whether
          // to retry or give up. WebSocket error is always followed by close.
        }
        ws.addEventListener("error", handleError)
        socketCleanups.push(() => ws.removeEventListener("error", handleError))

        // --- handleClose ---
        const handleClose = (event: CloseEvent) => {
          if (disposed) return
          trace("socket close", {
            code: event.code,
            reason: event.reason,
            clean: event.wasClean,
            reconnectAttempt,
          })

          // Normal close (1000) or non-error — do nothing
          if (!socketCloseIsError(event.code)) return

          // Session not found (1008) — PTY is gone, delegate to clone-on-reconnect
          if (event.code === 1008) {
            if (once.value) return
            once.value = true
            local.onConnectError?.(new WebSocketCloseError(event.code, event.reason))
            return
          }

          // Retriable error — schedule reconnect if under the limit
          if (isRetriableClose(event.code) && reconnectAttempt < MAX_RECONNECT_ATTEMPTS) {
            cleanupSocket()
            scheduleReconnect()
            return
          }

          // Exhausted retries or non-retriable code
          if (once.value) return
          once.value = true
          if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
            try { b.write(reconnectFailedMessage()) } catch {}
          }
          local.onConnectError?.(new WebSocketCloseError(event.code, event.reason))
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

    if (isDebug()) {
      trace("unmount", {
        msgCount,
        host: host(),
        backendCols: backend?.cols,
        backendRows: backend?.rows,
      })
      trace("summary", {
        msgCount,
        cursor,
        resizeBySource,
        stats,
      })
    }

    // Serialize state for restoration
    const pty = (() => {
      const live = safePty()
      if (live) return live
      return ptySnapshot
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
  )
}
