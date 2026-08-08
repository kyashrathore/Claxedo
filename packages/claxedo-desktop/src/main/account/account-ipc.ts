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

  for (const name of Object.keys(HOSTED_OPERATIONS) as HostedOperationName[]) {
    handle(hostedOperationChannel(name), async (_event: never, input?: Record<string, unknown>) =>
      // The operation name is bound HERE, at registration, not taken from the
      // message. A renderer can choose which channel to call and cannot choose
      // what that channel does.
      service.run(name, input ?? {}),
    )
  }

  return { channels }
}
