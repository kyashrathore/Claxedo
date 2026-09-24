import type { PlacementId, Server, TerminalFrame, TerminalId, TerminalStream, TerminalStreamClose } from "@/server"
import type { Machine } from "@/lib/machine"
import type { TerminalBackend } from "./backend/types"
import { asAppError, closeError, type TerminalConnection, type TerminalConnectionEvent } from "./model"
import { createWriteQueue } from "./write-queue"
import { capabilityResponses } from "./capability-responder"
import { stripTerminalReplies } from "./input-reply-filter"
import { createReconnectTimer, decideReconnect, isRetriableClose } from "./reconnect"
import { createResizePublisher } from "./resize"
import { t } from "./i18n"

const OVERLOAD_CLOSE_CODE = 4000

export type AttachInput = {
  readonly server: Server
  readonly placementId: PlacementId
  readonly terminalId: TerminalId
  readonly backend: TerminalBackend
  readonly host: HTMLElement
  readonly connection: Machine<TerminalConnection, TerminalConnectionEvent>
  readonly likelyTui: boolean
  readonly onPublishFailed: (error: unknown) => void
}

export type Attachment = {
  readonly retry: () => void
  readonly dispose: () => void
}

export function attachTerminal(input: AttachInput): Attachment {
  const { server, placementId, terminalId, backend, connection } = input
  let cursor = 0
  let replayReady = false
  let disposed = false
  let stream: TerminalStream | undefined
  const timer = createReconnectTimer()
  const send = (event: TerminalConnectionEvent) => connection.send(event)

  const queue = createWriteQueue({
    write: (chunk, done) => backend.write(chunk, done),
    onOverload: () => {
      stream?.close()
      send({ type: "closed", error: { class: "internal", message: t("terminal.overload"), retryable: false } })
    },
  })

  const resize = createResizePublisher({
    backend,
    host: input.host,
    likelyTui: input.likelyTui,
    publish: (size) => server.terminals.update(placementId, terminalId, { size }),
    onPublishFailed: input.onPublishFailed,
  })

  const restore = (frame: Extract<TerminalFrame, { kind: "cursor" }>) => {
    if (!frame.checkpoint) {
      queue.flushPending()
      return
    }
    queue.beginRestore()
    backend.restoreCheckpoint(frame.checkpoint).then(
      () => {
        if (disposed) return
        queue.flushPending()
        backend.fit()
      },
      (error: unknown) => {
        if (disposed) return
        stream?.close()
        send({ type: "closed", error: asAppError(error, t("terminal.restoreFailed")) })
      },
    )
  }

  const onFrame = (frame: TerminalFrame) => {
    if (disposed) return
    if (frame.kind === "cursor") {
      cursor = frame.cursor
      replayReady = true
      restore(frame)
      return
    }
    cursor += frame.data.length
    if (replayReady) {
      for (const response of capabilityResponses(frame.data, () => backend.getDefaultColors())) stream?.send(response)
    }
    queue.push(frame.data)
  }

  const decide = async () => {
    const state = connection.state()
    const attempt = state.kind === "detached" ? state.attempt : 1
    const presence = await server.terminals.presence(placementId, terminalId)
    if (disposed) return
    const decision = decideReconnect({ presence, attempt })
    if (decision.kind === "gone") {
      send({ type: "gone" })
      return
    }
    if (decision.kind === "giveUp") return
    timer.schedule(decision.delayMs, () => {
      send({ type: "retry" })
      void connect()
    })
  }

  const recover = (close: TerminalStreamClose) => {
    send({ type: "closed", error: closeError(close, t("terminal.connectionLost.description")) })
    decide().catch((error: unknown) => {
      if (!disposed) send({ type: "closed", error: asAppError(error, t("terminal.connectionLost.title")) })
    })
  }

  const onClose = (close: TerminalStreamClose) => {
    if (disposed) return
    stream = undefined
    if (close.code === 1000) {
      send({ type: "exited" })
      return
    }
    if (close.code === 1008) {
      send({ type: "gone" })
      return
    }
    if (close.code === OVERLOAD_CLOSE_CODE) return
    if (!isRetriableClose(close.code)) {
      send({ type: "closed", error: closeError(close, t("terminal.connectionLost.description")) })
      return
    }
    recover(close)
  }

  const connect = async () => {
    if (disposed) return
    replayReady = false
    try {
      const opened = await server.terminals.attach({
        placementId,
        terminalId,
        cursor,
        onOpen: () => {
          if (disposed) return
          send({ type: "opened" })
          resize.onOpen()
        },
        onFrame,
        onClose,
      })
      if (disposed) {
        opened.close()
        return
      }
      stream = opened
    } catch (error) {
      if (disposed) return
      recover({ code: 1006, reason: asAppError(error, t("terminal.connectionLost.title")).message })
    }
  }

  const disposeInput = backend.onData((data) => {
    const filtered = stripTerminalReplies(data)
    if (filtered) stream?.send(filtered)
  })

  void connect()

  return {
    retry: () => {
      if (disposed) return
      timer.cancel()
      send({ type: "retry" })
      void connect()
    },
    dispose: () => {
      disposed = true
      timer.cancel()
      disposeInput()
      resize.dispose()
      queue.dispose()
      stream?.close()
      stream = undefined
    },
  }
}
