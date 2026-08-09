/**
 * Assembling the account for a real Electron process.
 *
 * The one place electron, node, and the account modules meet. Everything it
 * does is wiring; every decision lives in the module it belongs to.
 *
 * Configuration comes from the environment because the OAuth client is
 * registered by the release owner in the identity provider, not by this code.
 * When it is absent the account is still constructed and still registers its
 * IPC — sign-in then refuses with a reason. The alternative, not registering,
 * would leave `window.api.account` missing, the renderer would fall back to the
 * BROWSER port, and a desktop build would quietly try to run Clerk in the
 * renderer — which is the arrangement this unit exists to end.
 */

import { app, safeStorage, shell } from "electron"
import { createAccountService, type AccountState } from "./account-service"
import { createCredentialStore } from "./credential-store"
import { credentialFile, loopbackListener, nodeTimer, refreshExchange, tokenExchange } from "./electron-seams"
import { registerAccountIpc, type AccountIpcTarget } from "./account-ipc"
import { readAccountConfig, type AccountConfigEnv } from "./account-config"
import type { OAuthSeams } from "./oauth-flow"

const SIGN_IN_TIMEOUT_MS = 5 * 60_000

/**
 * Build the account service and register its IPC.
 *
 * MUST be called after `installIpcCallerGuard`, like every other registration —
 * these channels spend a credential, so an unguarded one is the worst of the
 * sixty to leave open. `ipc-caller-guard.wiring.test.ts` pins the ordering.
 */
export type AccountAssemblyInput = {
  ipcMain: AccountIpcTarget
  env?: AccountConfigEnv
  onError?: (stage: string, error: unknown) => void
  onStateChange?: (next: AccountState, previous: AccountState) => void
}

/**
 * Construct the account adapter without registering IPC.
 *
 * The lazy main-process broker owns the one IPC registration and calls this
 * only after sign-in is requested or a nonsecret credential marker exists.
 * Keeping construction separate from registration is what lets unsigned boot
 * expose the closed protocol without importing Electron OAuth/storage code.
 */
export function createAccountAssembly(input: Omit<AccountAssemblyInput, "ipcMain">) {
  const config = readAccountConfig(input.env ?? (process.env as AccountConfigEnv))

  if (!config.configured) {
    // A service that refuses, rather than no service. See the note at the top:
    // an absent bridge sends the renderer back to the browser port.
    const unavailable: AccountState = {
      status: "unavailable",
      reason: "callback-failed",
      detail: `this build has no account client configured (missing: ${config.missing.join(", ")})`,
    }
    return {
      configured: false as const,
      missing: config.missing,
      service: {
        state: () => unavailable,
        signIn: async () => unavailable,
        signOut: async () => {},
        run: async () => {
          throw new Error(unavailable.detail)
        },
      },
    }
  }

  const store = createCredentialStore({
    safeStorage,
    file: credentialFile(app.getPath("userData")),
    platform: process.platform,
    ...(input.onError ? { onRejected: (reason) => input.onError?.("credential", reason) } : {}),
  })

  const seams: OAuthSeams = {
    // The system browser, never an in-app window: an embedded window rendering
    // the provider's password field is indistinguishable from phishing, and
    // cannot use the user's existing session or password manager.
    openExternal: (url) => shell.openExternal(url),
    listen: loopbackListener(),
    exchange: tokenExchange(),
    safeStorage: () => ({
      available: safeStorage.isEncryptionAvailable(),
      backend: safeStorage.getSelectedStorageBackend?.() ?? "unknown",
      platform: process.platform,
    }),
    setTimeout: nodeTimer(),
  }

  // The refresh grant, bound to the same client and token endpoint the sign-in
  // used. Supplying it is what makes a session outlive one access token: with
  // no `refresh` the service can only sign the user out at expiry, which for a
  // typical one-hour token means every day starts signed out.
  const refresh = refreshExchange()

  const service = createAccountService({
    config: {
      authorizeUrl: config.authorizeUrl,
      tokenUrl: config.tokenUrl,
      clientId: config.clientId,
      scope: config.scope,
      timeoutMs: SIGN_IN_TIMEOUT_MS,
    },
    seams,
    store,
    serverOrigin: config.serverOrigin,
    fetch: (url, init) => fetch(url, init),
    refresh: (refreshToken) => refresh({ tokenUrl: config.tokenUrl, clientId: config.clientId, refreshToken }),
    now: () => Math.floor(Date.now() / 1000),
    ...(input.onError ? { onError: input.onError } : {}),
    ...(input.onStateChange ? { onStateChange: input.onStateChange } : {}),
  })

  // Before registering: a renderer that asks for state during its first frame
  // should get the restored answer, not `unsigned` followed by a correction.
  service.restore()
  return { configured: true as const, service }
}

export type AccountAssembly = ReturnType<typeof createAccountAssembly>

export function setupAccount(input: AccountAssemblyInput) {
  const account = createAccountAssembly(input)
  const { channels } = registerAccountIpc({ ipcMain: input.ipcMain, service: account.service })
  return account.configured
    ? { ...account, channels }
    : { configured: false as const, missing: account.missing, channels }
}
