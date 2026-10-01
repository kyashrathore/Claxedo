/**
 * The account's IPC surface: one channel per named operation, and nothing else.
 *
 * Registration is generated from `HOSTED_OPERATIONS` rather than written by
 * hand. A hand-written list is a second place the set of operations lives, and
 * the two would eventually disagree in the direction nobody notices — an extra
 * channel serving something the matrix never described.
 *
 * These register through the same `ipcMain` the caller guard has already
 * wrapped, so every one of them is sender-checked. That ordering is enforced in
 * `index.ts`, not here: this module has no way to know when it is called, which
 * is exactly why `ipc-caller-guard.wiring.test.ts` checks the entry instead.
 */

import { randomUUID } from "node:crypto"
import type { IpcMainInvokeEvent } from "electron"
import { asRecord } from "@claxedo/helpers/guards"
import { readRecord, readString } from "@claxedo/helpers/readers"
import {
  HOSTED_OPERATIONS,
  hostedOperationNames,
  isStreamHostedOperation,
  type HostedOperationName,
} from "@claxedo/account-contract"
import type { AccountState } from "./account-service"

export const ACCOUNT_STATE_CHANNEL = "claxedo.account.state"
export const ACCOUNT_STATE_CHANGED_CHANNEL = "claxedo.account.stateChanged"
export const ACCOUNT_SIGN_IN_CHANNEL = "claxedo.account.signIn"
export const ACCOUNT_SIGN_OUT_CHANNEL = "claxedo.account.signOut"
export const ACCOUNT_STREAM_OPEN_CHANNEL = "claxedo.account.stream.open"
export const ACCOUNT_STREAM_START_CHANNEL = "claxedo.account.stream.start"
export const ACCOUNT_STREAM_CLOSE_CHANNEL = "claxedo.account.stream.close"
export const ACCOUNT_STREAM_CHUNK_CHANNEL = "claxedo.account.stream.chunk"
export const ACCOUNT_STREAM_END_CHANNEL = "claxedo.account.stream.end"
export const ACCOUNT_STREAM_ERROR_CHANNEL = "claxedo.account.stream.error"
const ACCOUNT_STREAM_RESERVATION_TTL_MS = 30_000

/**
 * Operations main performs but the renderer may not ask for: the declarations
 * with `exposure.renderer: false`, each of which says why next to it in
 * `@claxedo/account-contract`. Withheld channels stay registered, so the IPC
 * surface equals the operation table and a call to one is a named refusal
 * rather than a missing channel.
 */
export const RENDERER_WITHHELD_OPERATIONS: readonly HostedOperationName[] = hostedOperationNames().filter(
  (name) => !HOSTED_OPERATIONS[name].exposure.renderer,
)

/** One channel per operation: a single channel taking a name is a place for a future argument to become the route. */
export function hostedOperationChannel(name: HostedOperationName) {
  return `claxedo.account.operation:${name}`
}

/**
 * The registration surface, matching Electron's own so the real `ipcMain`
 * satisfies it. The import is type-only and erases, keeping this module
 * loadable outside an Electron process — the same split the rest of `main/`
 * uses to stay testable.
 */
export type AccountIpcTarget = {
  handle(channel: string, listener: AccountIpcListener): unknown
}

/** One listener shape for every account channel. Electron's own satisfies it. */
export type AccountIpcListener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

export type AccountIpcService = {
  state: () => AccountState
  signIn: () => Promise<unknown>
  signOut: () => Promise<void>
  run: (name: HostedOperationName, input?: Record<string, unknown>) => Promise<unknown>
  openStream: (input: {
    name: HostedOperationName
    params?: Record<string, unknown>
    signal?: AbortSignal
    onChunk: (text: string) => void
  }) => Promise<void>
}

/**
 * Register the account channels.
 *
 * `signIn` returns the STATE rather than the flow's result: the result carries
 * a token set, and a handler that returned it would put the credential on the
 * IPC boundary — the one thing this whole arrangement exists to prevent.
 */
export function registerAccountIpc(input: { ipcMain: AccountIpcTarget; service: AccountIpcService }) {
  const { ipcMain, service } = input
  const channels: string[] = []

  const handle = (channel: string, listener: AccountIpcListener) => {
    channels.push(channel)
    ipcMain.handle(channel, listener)
  }

  handle(ACCOUNT_STATE_CHANNEL, () => service.state())
  handle(ACCOUNT_SIGN_IN_CHANNEL, async () => {
    await service.signIn()
    return service.state()
  })
  handle(ACCOUNT_SIGN_OUT_CHANNEL, async () => {
    await service.signOut()
    return service.state()
  })

  const withheld = new Set<HostedOperationName>(RENDERER_WITHHELD_OPERATIONS)
  type StreamSender = IpcMainInvokeEvent["sender"]
  type ActiveStream = {
    operation: HostedOperationName
    params: Record<string, unknown>
    sender: StreamSender
    controller: AbortController
    state: "reserved" | "started"
    onDestroyed: () => void
    reservationTimer?: ReturnType<typeof setTimeout>
  }
  const activeStreams = new Map<string, ActiveStream>()

  const cleanupStream = (streamId: string, expected?: ActiveStream) => {
    const stream = activeStreams.get(streamId)
    if (!stream || (expected && stream !== expected)) return
    activeStreams.delete(streamId)
    if (stream.reservationTimer) clearTimeout(stream.reservationTimer)
    stream.controller.abort()
    try {
      stream.sender.removeListener("destroyed", stream.onDestroyed)
    } catch {
      // sender may already be gone
    }
  }

  for (const name of hostedOperationNames()) {
    if (withheld.has(name)) {
      // Refused before `service.run`, so no request is made: no token is
      // minted, no nonce is burned, and no renderer-supplied public key
      // reaches the enrollment route. See `RENDERER_WITHHELD_OPERATIONS`.
      handle(hostedOperationChannel(name), async () => {
        throw new Error(`hosted operation "${name}" is performed by Electron main and is not available to the renderer`)
      })
      continue
    }

    if (isStreamHostedOperation(name)) {
      // Stream ops stay registered so channel inventory matches HOSTED_OPERATIONS,
      // but unary invoke is refused — open via ACCOUNT_STREAM_OPEN_CHANNEL.
      handle(hostedOperationChannel(name), async () => {
        throw new Error(`hosted operation "${name}" is a stream; use ${ACCOUNT_STREAM_OPEN_CHANNEL}`)
      })
      continue
    }

    handle(hostedOperationChannel(name), async (_event, input) => {
      // The operation name is bound HERE, at registration, not taken from the
      // message. A renderer can choose which channel to call and cannot choose
      // what that channel does.
      return service.run(name, asRecord(input) ?? {})
    })
  }

  handle(ACCOUNT_STREAM_OPEN_CHANNEL, async (event, payload) => {
    // Read, not declared: the payload is renderer input, so the operation name
    // has to survive a check before it can pick a stream.
    const operation = readString(payload, "operation")
    if (!operation || !isStreamHostedOperation(operation)) {
      throw new Error(`hosted stream operation "${String(operation)}" is not allowed`)
    }
    if (withheld.has(operation)) {
      throw new Error(`hosted operation "${operation}" is performed by Electron main and is not available to the renderer`)
    }
    const streamId = randomUUID()
    const controller = new AbortController()
    const sender = event.sender
    const stream: ActiveStream = {
      operation,
      params: readRecord(payload, "input") ?? {},
      sender,
      controller,
      state: "reserved",
      onDestroyed: () => cleanupStream(streamId),
    }
    activeStreams.set(streamId, stream)
    stream.reservationTimer = setTimeout(
      () => cleanupStream(streamId, stream),
      ACCOUNT_STREAM_RESERVATION_TTL_MS,
    )
    stream.reservationTimer.unref()
    sender.once("destroyed", stream.onDestroyed)
    return { streamId }
  })

  // Opening only reserves the id. The renderer subscribes to all three push
  // channels before invoking start, so even a service that emits and settles
  // synchronously cannot outrun its listeners.
  handle(ACCOUNT_STREAM_START_CHANNEL, async (event, payload) => {
    const streamId = readString(payload, "streamId")
    if (!streamId) throw new Error("unknown account stream")
    const stream = activeStreams.get(streamId)
    if (!stream || stream.sender !== event.sender) {
      throw new Error(`unknown account stream "${streamId}"`)
    }
    if (stream.state === "started") {
      throw new Error(`account stream "${streamId}" already started`)
    }
    stream.state = "started"
    if (stream.reservationTimer) {
      clearTimeout(stream.reservationTimer)
      delete stream.reservationTimer
    }
    let running: Promise<void>
    try {
      running = service.openStream({
        name: stream.operation,
        params: stream.params,
        signal: stream.controller.signal,
        onChunk: (text) => {
          if (activeStreams.get(streamId) !== stream || stream.sender.isDestroyed()) return
          stream.sender.send(ACCOUNT_STREAM_CHUNK_CHANNEL, { streamId, text })
        },
      })
    } catch (error) {
      running = Promise.reject(error)
    }
    void running.then(() => {
      if (activeStreams.get(streamId) === stream && !stream.sender.isDestroyed()) {
        stream.sender.send(ACCOUNT_STREAM_END_CHANNEL, { streamId })
      }
    }).catch((error) => {
      if (activeStreams.get(streamId) === stream && !stream.sender.isDestroyed()) {
        stream.sender.send(ACCOUNT_STREAM_ERROR_CHANNEL, {
          streamId,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }).finally(() => {
      cleanupStream(streamId, stream)
    })
  })

  handle(ACCOUNT_STREAM_CLOSE_CHANNEL, async (event, payload) => {
    const streamId = readString(payload, "streamId")
    if (!streamId) return
    const stream = activeStreams.get(streamId)
    if (!stream || stream.sender !== event.sender) return
    cleanupStream(streamId, stream)
  })

  return { channels }
}
