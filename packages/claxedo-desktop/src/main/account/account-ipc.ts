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
import {
  HOSTED_OPERATIONS,
  hostedOperationChannel,
  isStreamHostedOperation,
  type HostedOperationName,
} from "./hosted-operations"
import type { AccountState } from "./account-service"
import { accountPerfEnabled, accountPerfMark, accountPerfNow } from "./account-perf"

export const ACCOUNT_STATE_CHANNEL = "claxedo.account.state"
export const ACCOUNT_STATE_CHANGED_CHANNEL = "claxedo.account.stateChanged"
export const ACCOUNT_SIGN_IN_CHANNEL = "claxedo.account.signIn"
export const ACCOUNT_SIGN_OUT_CHANNEL = "claxedo.account.signOut"
export const ACCOUNT_STREAM_OPEN_CHANNEL = "claxedo.account.stream.open"
export const ACCOUNT_STREAM_CLOSE_CHANNEL = "claxedo.account.stream.close"
export const ACCOUNT_STREAM_CHUNK_CHANNEL = "claxedo.account.stream.chunk"
export const ACCOUNT_STREAM_END_CHANNEL = "claxedo.account.stream.end"
export const ACCOUNT_STREAM_ERROR_CHANNEL = "claxedo.account.stream.error"

/**
 * Operations the renderer may not ask for, though main itself performs them.
 *
 * `HOSTED_OPERATIONS` is main's capability table — the closed set of
 * authenticated calls THIS PROCESS may make. It is not automatically the set
 * the renderer may trigger, and two kinds of operation come apart from it.
 *
 * ## 1. The RESULT is a credential — `account.cliExchange`
 *
 * `POST /api/auth/cli/exchange` answers with `access_token`,
 * `refresh_token`, `token_type` and `expires_in` — a long-lived CLI session
 * pair — and this module used to hand that body straight back over IPC. U8-R7
 * says the renderer never receives account bearer or refresh tokens, and
 * `signIn` two handlers below has always returned the STATE rather than the
 * flow's token set for exactly this reason. The generated operation loop
 * quietly reopened the hole that handler was written to close.
 *
 * REFUSED, not redacted. Discarding the response after the call would keep the
 * credential out of the renderer but still let a compromised one mint CLI
 * sessions at will — every exchange is a real mint, recorded in the revocation
 * registry — so the useful disposition is to never reach the server at all. And
 * nothing is lost: no renderer code calls this operation. `cli-login` in
 * `@claxedo/app` is a WEB flow that fetches the exchange with the page's own
 * session and posts the token to the CLI's loopback listener; it does not go
 * through this port, on any surface.
 *
 * ## 2. The PARAMETERS are a credential — the three `host.*` operations
 *
 * The machine identity is a P-256 private key that never expires and is the
 * entire authorisation for reaching this laptop remotely.
 * `host-connector/identity-store.ts` owns it, keeps it inside the OS secure
 * store, and refuses to mint one when that store is a lie. The renderer has no
 * part in it and cannot produce one.
 *
 * But `host.enrollCurrentMachine` declares `publicKey` and `signature` as body
 * fields substituted from the CALLER, and the route stores whatever public key
 * it is handed (`enrollBody` in `routes/hosted/host-enrollment.ts`). So a
 * renderer holding this channel generates its own keypair, takes a nonce from
 * `host.enrollmentNonce` — which is why that one is withheld too, it is step
 * one of the same handshake — signs it, and enrolls a machine whose private
 * half main has never seen, under the owner's account and on main's bearer.
 * Worse on a second call: `enrollForUser` in
 * `convex/hostEnrollments.ts` PATCHES an existing row for the same `host_id`,
 * overwriting `public_key` and clearing `paused_at`/`revoked_at` — the exact
 * "same machine id presenting a different public key" takeover
 * `identity-store.ts` treats as unusable, and an
 * un-revoke of a machine the user revoked.
 *
 * These stay in the table because MAIN brokers them for the separately built
 * Host Connector child. The child fills `publicKey` and `signature` from the
 * in-memory bootstrap key, while Electron attaches account authorization. The
 * renderer's route to the same feature is the Host Connector's own IPC
 * (`host-connector/ipc.ts`), whose four operations take NO ARGUMENTS: pressing
 * Enable calls `claxedo.hostConnector.start`, and main decides everything
 * about the enrollment it then signs. Nothing in `@claxedo/app` names a
 * `host.*` account operation — `electron-machine-remote-access.ts` binds the
 * connector bridge, not this port.
 *
 * Withheld rather than re-shaped, deliberately. Deriving the fields inside the
 * operation table would mean `account/` reading the machine key, and the two
 * are kept apart on purpose: `host-connector/child-supervisor.ts` brokers only
 * fixed operation names because the child must not see the account credential,
 * and account code must not receive the machine key. The renderer is the only caller that has no
 * business here, so the renderer is what gets refused.
 *
 * The channel is still REGISTERED. Dropping it would make the IPC surface stop
 * matching the operation table, and that equality is what lets
 * `account-ipc.test.ts` catch an EXTRA channel — the failure that actually
 * matters here. A registered channel that refuses says what it is; a missing
 * one is indistinguishable from one nobody wired.
 *
 * Adding a name here is a narrowing and needs no matrix change. REMOVING one
 * means a renderer surface is about to reach an operation main was reserving.
 * For a case-1 name, ask what the surface needs from the result — a field, not
 * the body. For a case-2 name the answer is never removal: the renderer cannot
 * hold a machine key, so what it needs is a zero-argument operation on the Host
 * Connector's own IPC, where main supplies the identity.
 */
export const RENDERER_WITHHELD_OPERATIONS: readonly HostedOperationName[] = [
  "account.cliExchange",
  "host.enrollCurrentMachine",
  "host.enrollmentNonce",
  "host.enrollmentHeartbeat",
]

/**
 * The registration surface, matching Electron's own so the real `ipcMain`
 * satisfies it. The import is type-only and erases, keeping this module
 * loadable outside an Electron process — the same split the rest of `main/`
 * uses to stay testable.
 */
export type AccountIpcTarget = {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): unknown
}

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

  const handle = (channel: string, listener: (...args: never[]) => unknown) => {
    channels.push(channel)
    ipcMain.handle(channel, listener as never)
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
  const activeStreams = new Map<string, AbortController>()

  for (const name of Object.keys(HOSTED_OPERATIONS) as HostedOperationName[]) {
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

    handle(hostedOperationChannel(name), async (_event: never, input?: Record<string, unknown>) => {
      // The operation name is bound HERE, at registration, not taken from the
      // message. A renderer can choose which channel to call and cannot choose
      // what that channel does.
      const started = accountPerfNow()
      try {
        return await service.run(name, input ?? {})
      } finally {
        accountPerfMark("account.unary_ipc_handler_ms", {
          operation: name,
          ms: accountPerfNow() - started,
        })
      }
    })
  }

  handle(ACCOUNT_STREAM_OPEN_CHANNEL, async (event: IpcMainInvokeEvent, payload?: {
    operation?: string
    input?: Record<string, unknown>
  }) => {
    const operation = payload?.operation
    if (!operation || !isStreamHostedOperation(operation)) {
      throw new Error(`hosted stream operation "${String(operation)}" is not allowed`)
    }
    if (withheld.has(operation)) {
      throw new Error(`hosted operation "${operation}" is performed by Electron main and is not available to the renderer`)
    }
    const streamId = randomUUID()
    const controller = new AbortController()
    activeStreams.set(streamId, controller)
    const sender = event.sender
    const openInvokeAt = accountPerfNow()
    let chunkSeq = 0
    const cleanup = () => {
      activeStreams.delete(streamId)
      controller.abort()
    }
    sender.once("destroyed", cleanup)
    void service.openStream({
      name: operation,
      params: payload?.input ?? {},
      signal: controller.signal,
      onChunk: (text) => {
        if (sender.isDestroyed()) return
        const seq = chunkSeq++
        const sentAt = accountPerfNow()
        if (accountPerfEnabled() && seq === 0) {
          accountPerfMark("account.stream_chunk_ipc_first_ms", {
            streamId,
            operation,
            ms: sentAt - openInvokeAt,
            bytes: text.length,
          })
        }
        sender.send(ACCOUNT_STREAM_CHUNK_CHANNEL, {
          streamId,
          text,
          ...(accountPerfEnabled() ? { seq, sentAt } : {}),
        })
      },
    }).then(() => {
      if (!sender.isDestroyed()) sender.send(ACCOUNT_STREAM_END_CHANNEL, { streamId })
    }).catch((error) => {
      if (!sender.isDestroyed()) {
        sender.send(ACCOUNT_STREAM_ERROR_CHANNEL, {
          streamId,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }).finally(() => {
      activeStreams.delete(streamId)
      try {
        sender.removeListener("destroyed", cleanup)
      } catch {
        // sender may already be gone
      }
    })
    return { streamId }
  })

  handle(ACCOUNT_STREAM_CLOSE_CHANNEL, async (_event: never, payload?: { streamId?: string }) => {
    const streamId = payload?.streamId
    if (!streamId) return
    const controller = activeStreams.get(streamId)
    if (!controller) return
    controller.abort()
    activeStreams.delete(streamId)
  })

  return { channels }
}
