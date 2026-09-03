/**
 * Assembling the account for a real Electron process.
 *
 * The one place electron, node, and the account modules meet. Everything it
 * does is wiring; every decision lives in the module it belongs to.
 *
 * The environment selects only one exact HTTPS core origin. That core's live,
 * short-lived descriptor selects the auth adapter and supplies every
 * public native-client value. When the origin is absent the account still
 * registers its refusing IPC service; the renderer never falls back to a
 * browser provider implementation.
 */

import { app, safeStorage, shell } from "electron"
import { createAccountService, type AccountState } from "./account-service"
import { createCredentialStore } from "./credential-store"
import { credentialFile, loopbackListener, nodeTimer, refreshExchange, tokenExchange } from "./electron-seams"
import { createDesktopNativeAuth } from "./desktop-native-auth"
import { noConnectionReuseFetch } from "./no-reuse-fetch"
import { registerAccountIpc, type AccountIpcTarget } from "./account-ipc"
import { readAccountConfig, type AccountConfigEnv } from "./account-config"
import { createIdentityResolver, userInfoUrlFromTokenUrl } from "./identity"
import type { OAuthSeams } from "./oauth-flow"

/** How long to wait for the browser callback before failing the attempt. */
const SIGN_IN_TIMEOUT_MS = 90_000

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
      ready: Promise.resolve(),
      service: {
        state: () => unavailable,
        signIn: async () => unavailable,
        signOut: async () => {},
        run: async () => {
          throw new Error(unavailable.detail)
        },
        openStream: async () => {
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

  const releaseValidationOperation = config.releaseValidationOperation
  const canaryJourneyId = config.canaryJourneyId
  // Core-origin traffic never reuses a connection (see no-reuse-fetch.ts for
  // the poisoned keep-alive pool this removes); anything else keeps the
  // platform fetch. Release-phase identification rides the same seam, so the
  // descriptor, token, refresh, revoke, and hosted operations all carry it.
  const controlPlaneFetch: typeof fetch = (request, init) => {
    const next = new Request(request, init)
    if (new URL(next.url).origin !== config.coreOrigin) return fetch(next)
    if (!releaseValidationOperation && !canaryJourneyId) return noConnectionReuseFetch(next)
    const headers = new Headers(next.headers)
    if (releaseValidationOperation && !headers.has("x-claxedo-multiplayer-validation-operation")) {
      headers.set("x-claxedo-multiplayer-validation-operation", releaseValidationOperation)
    }
    if (canaryJourneyId && !headers.has("x-claxedo-canary-journey-id")) {
      headers.set("x-claxedo-canary-journey-id", canaryJourneyId)
    }
    // The canary gate serializes the release's FIRST product write and demands
    // every mutation name an operation id; without one the gate throws and the
    // Worker answers 503 deployment_candidate_unavailable — which is exactly
    // what "Share workspace" hit. One stable id per journey suffices: the gate
    // records the first write's id and admits later mutations by identity.
    const unsafe = next.method !== "GET" && next.method !== "HEAD" && next.method !== "OPTIONS"
    if (canaryJourneyId && unsafe && !headers.has("x-claxedo-canary-mutation-operation-id")) {
      headers.set("x-claxedo-canary-mutation-operation-id", `${canaryJourneyId}-desktop-write`)
    }
    return noConnectionReuseFetch(new Request(next, { headers }))
  }

  const seams: OAuthSeams = {
    // The system browser, never an in-app window: an embedded window rendering
    // the provider's password field is indistinguishable from phishing, and
    // cannot use the user's existing session or password manager.
    openExternal: (url) => shell.openExternal(url),
    listen: loopbackListener(),
    // The exchange is a request to the selected core just like descriptor,
    // refresh, revoke, and hosted operations. Release-validation builds must
    // identify it through the same canonical fetch; bypassing that fetch made
    // the public token request indistinguishable from an unbound multiplayer
    // request after cutover.
    exchange: tokenExchange(controlPlaneFetch),
    safeStorage: () => ({
      available: safeStorage.isEncryptionAvailable(),
      backend: safeStorage.getSelectedStorageBackend?.() ?? "unknown",
      platform: process.platform,
    }),
    setTimeout: nodeTimer(),
  }

  const auth = createDesktopNativeAuth({
    coreOrigin: config.coreOrigin,
    seams,
    refresh: refreshExchange(controlPlaneFetch),
    fetch: controlPlaneFetch,
    timeoutMs: SIGN_IN_TIMEOUT_MS,
  })

  const service = createAccountService({
    auth,
    store,
    fetch: (url, init) => controlPlaneFetch(url, init),
    now: () => Math.floor(Date.now() / 1000),
    // Without this the service short-circuits and every signed account keeps
    // the empty identity it starts with, so account surfaces show the literal
    // word "Account" instead of the person. The userinfo URL is not a config
    // value: it is derived from the live descriptor's token endpoint, which is
    // the same trust anchor the rest of this flow uses.
    resolveIdentity: async (accessToken) => {
      const descriptor = await auth.discover()
      const userInfoUrl = userInfoUrlFromTokenUrl(descriptor.tokenUrl)
      if (!userInfoUrl) return { userId: "" }
      return await createIdentityResolver({
        userInfoUrl,
        fetch: controlPlaneFetch,
        ...(input.onError ? { onError: (error) => input.onError?.("identity", error) } : {}),
      })(accessToken)
    },
    ...(input.onError ? { onError: input.onError } : {}),
    ...(input.onStateChange ? { onStateChange: input.onStateChange } : {}),
  })

  // Before registering: a renderer that asks for state during its first frame
  // should get the restored answer, not `unsigned` followed by a correction.
  const ready = service.restore().then(() => undefined)
  return { configured: true as const, service, ready }
}

export type AccountAssembly = ReturnType<typeof createAccountAssembly>

export function setupAccount(input: AccountAssemblyInput) {
  const account = createAccountAssembly(input)
  const { channels } = registerAccountIpc({ ipcMain: input.ipcMain, service: account.service })
  return account.configured
    ? { ...account, channels }
    : { configured: false as const, missing: account.missing, channels, ready: account.ready }
}
