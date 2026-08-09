import type { AccountState } from "./account-service"
import {
  registerAccountIpc,
  type AccountIpcService,
  type AccountIpcTarget,
} from "./account-ipc"
import type { AccountConfigEnv } from "./account-config"
import type { AccountAssemblyInput, createAccountAssembly } from "./index"
import { hasAccountCredentialRecord } from "./marker"

type AccountModule = {
  createAccountAssembly: typeof createAccountAssembly
}

export type LazyAccount = {
  /** Resolves after marker-driven restore; immediate for an unsigned profile. */
  ready: Promise<void>
  state: () => AccountState
  run: AccountIpcService["run"]
}

const unsigned: AccountState = { status: "unsigned" }

/**
 * Register the account protocol without importing the account adapter.
 *
 * A real stored-record marker restores eagerly so the renderer's first state
 * is authoritative. An empty profile stays on the dependency-light proxy until
 * the user explicitly signs in or invokes a hosted operation.
 */
export function setupLazyAccount(input: {
  ipcMain: AccountIpcTarget
  userDataDir: string
  /** Gate Electron-backed adapter construction until secure storage is ready. */
  adapterReady?: Promise<unknown>
  env?: AccountConfigEnv
  onError?: AccountAssemblyInput["onError"]
  onStateChange?: AccountAssemblyInput["onStateChange"]
  load?: () => Promise<AccountModule>
}): LazyAccount {
  let assembly: ReturnType<typeof createAccountAssembly> | undefined
  let loading: Promise<ReturnType<typeof createAccountAssembly>> | undefined

  const load = input.load ?? (async () => await import("./index"))
  const ensureLoaded = () => {
    loading ??= Promise.resolve(input.adapterReady)
      .then(load)
      .then((module) => {
        assembly = module.createAccountAssembly({
          ...(input.env ? { env: input.env } : {}),
          ...(input.onError ? { onError: input.onError } : {}),
          ...(input.onStateChange ? { onStateChange: input.onStateChange } : {}),
        })
        return assembly
      })
    return loading
  }

  const service: AccountIpcService = {
    state: () => assembly?.service.state() ?? unsigned,
    signIn: async () => await (await ensureLoaded()).service.signIn(),
    signOut: async () => {
      if (!assembly && !hasAccountCredentialRecord(input.userDataDir)) return
      await (await ensureLoaded()).service.signOut()
    },
    run: async (name, params) => await (await ensureLoaded()).service.run(name, params),
  }

  registerAccountIpc({ ipcMain: input.ipcMain, service })
  const ready = hasAccountCredentialRecord(input.userDataDir)
    ? ensureLoaded().then(() => undefined)
    : Promise.resolve()

  return {
    ready,
    state: service.state,
    run: service.run,
  }
}
