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

import type { IpcMainInvokeEvent } from "electron"
import { HOSTED_OPERATIONS, hostedOperationChannel, type HostedOperationName } from "./hosted-operations"
import type { AccountState } from "./account-service"

export const ACCOUNT_STATE_CHANNEL = "claxedo.account.state"
export const ACCOUNT_SIGN_IN_CHANNEL = "claxedo.account.signIn"
export const ACCOUNT_SIGN_OUT_CHANNEL = "claxedo.account.signOut"

/**
 * Operations whose RESULT is itself a credential, and which the renderer
 * therefore cannot ask for.
 *
 * `HOSTED_OPERATIONS` is main's capability table — the closed set of
 * authenticated calls THIS PROCESS may make. It is not automatically the set
 * the renderer may trigger, and `account.cliExchange` is where those two come
 * apart: `POST /api/auth/cli/exchange` answers with `access_token`,
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
 * The channel is still REGISTERED. Dropping it would make the IPC surface stop
 * matching the operation table, and that equality is what lets
 * `account-ipc.test.ts` catch an EXTRA channel — the failure that actually
 * matters here. A registered channel that refuses says what it is; a missing
 * one is indistinguishable from one nobody wired.
 *
 * Adding a name here is a narrowing and needs no matrix change. REMOVING one
 * means a renderer surface is about to receive an operation's result, so the
 * question to answer first is what it needs from it — a field, not the body.
 */
export const RENDERER_WITHHELD_OPERATIONS: readonly HostedOperationName[] = ["account.cliExchange"]

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

  for (const name of Object.keys(HOSTED_OPERATIONS) as HostedOperationName[]) {
    if (withheld.has(name)) {
      // Refused before `service.run`, so no request is made and no token is
      // minted. See `RENDERER_WITHHELD_OPERATIONS`.
      handle(hostedOperationChannel(name), async () => {
        throw new Error(`hosted operation "${name}" returns a credential and is not available to the renderer`)
      })
      continue
    }

    handle(hostedOperationChannel(name), async (_event: never, input?: Record<string, unknown>) =>
      // The operation name is bound HERE, at registration, not taken from the
      // message. A renderer can choose which channel to call and cannot choose
      // what that channel does.
      service.run(name, input ?? {}),
    )
  }

  return { channels }
}
